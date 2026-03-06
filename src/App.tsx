import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'

type DateAvailability = Record<string, string[]>

type FirestoreAvailability = {
  dateKey: string
  names: string[]
}

type Trip = {
  id: string
  name: string
  createdBy: string
}

function getFirebaseErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }

  return null
}

const EXTRA_COLORS = [
  'bg-fuchsia-500',
  'bg-indigo-500',
  'bg-cyan-500',
  'bg-lime-500',
  'bg-orange-500',
  'bg-teal-500',
]
const WEEKDAY_LABELS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam']
const STORAGE_NAME_KEY = 'travel-calendar-name'
const DATE_LOCALE = 'fr-FR'

function monthLabel(date: Date): string {
  return date.toLocaleString(DATE_LOCALE, { month: 'long', year: 'numeric' })
}

function dateKeyFor(day: Date): string {
  const year = day.getFullYear()
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

// format : Jeudi 14 Septembre
function friendlyDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(DATE_LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).padStart(1, '0').replace(/^\w/, (c) => c.toUpperCase())
}

function colorForName(name: string): string {
  const hash = [...name].reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return EXTRA_COLORS[hash % EXTRA_COLORS.length]
}

function calendarDays(currentMonth: Date): Date[] {
  const start = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1)
  const firstGridDay = new Date(start)
  firstGridDay.setDate(start.getDate() - start.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(firstGridDay)
    day.setDate(firstGridDay.getDate() + index)
    return day
  })
}

function App() {
  const [selectedName, setSelectedName] = useState<string>(() => {
    return localStorage.getItem(STORAGE_NAME_KEY) ?? ''
  })
  const [isNameModalDismissed, setIsNameModalDismissed] = useState(false)
  const [pickerCustomName, setPickerCustomName] = useState('')
  const [tripInputName, setTripInputName] = useState('')
  const [currentMonth, setCurrentMonth] = useState<Date>(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  )
  const [trips, setTrips] = useState<Trip[]>([])
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  const [isTripModalOpen, setIsTripModalOpen] = useState(true)
  const [isTripsLoaded, setIsTripsLoaded] = useState(false)
  const [availabilityByDate, setAvailabilityByDate] = useState<DateAvailability>({})
  const [isSyncing, setIsSyncing] = useState(false)
  const [uiError, setUiError] = useState('')
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null)

  const hasSelectedName = selectedName.trim().length > 0
  const showNamePicker = !hasSelectedName && !isNameModalDismissed

  const selectedTrip = useMemo(() => {
    return trips.find((trip) => trip.id === selectedTripId) ?? null
  }, [selectedTripId, trips])

  useEffect(() => {
    const tripsRef = collection(db, 'trips')

    const unsubscribe = onSnapshot(tripsRef, (snapshot) => {
      const nextTrips = snapshot.docs
        .map((tripDoc) => {
          const data = tripDoc.data() as { createdBy?: string; name?: string }
          if (typeof data.name !== 'string' || data.name.trim().length === 0) {
            return null
          }

          return {
            id: tripDoc.id,
            name: data.name,
            createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
          } satisfies Trip
        })
        .filter((trip): trip is Trip => trip !== null)
        .sort((a, b) => a.name.localeCompare(b.name, DATE_LOCALE))

      setTrips(nextTrips)
      setIsTripsLoaded(true)
      setUiError('')
    }, (error) => {
      const code = getFirebaseErrorCode(error)
      if (code === 'permission-denied') {
        setUiError('Permissions Firestore insuffisantes pour lire les voyages. Mettez à jour les règles Firestore.')
      } else {
        setUiError('Impossible de charger les voyages pour le moment.')
      }
      setIsTripsLoaded(true)
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    if (!isTripsLoaded) {
      return
    }

    if (trips.length === 0) {
      setSelectedTripId(null)
      setIsTripModalOpen(true)
      return
    }

    if (selectedTripId && !trips.some((trip) => trip.id === selectedTripId)) {
      setSelectedTripId(null)
      setIsTripModalOpen(true)
      return
    }

    if (!selectedTripId) {
      setIsTripModalOpen(true)
    }
  }, [isTripsLoaded, selectedTripId, trips])

  useEffect(() => {
    if (!selectedTripId) {
      setAvailabilityByDate({})
      return
    }

    const unsubscribe = onSnapshot(collection(db, 'trips', selectedTripId, 'availability'), (snapshot) => {
      const nextState: DateAvailability = {}

      snapshot.forEach((docItem) => {
        const data = docItem.data() as FirestoreAvailability
        if (Array.isArray(data.names) && typeof data.dateKey === 'string') {
          nextState[data.dateKey] = data.names
        }
      })

      setAvailabilityByDate(nextState)
      setUiError('')
    }, (error) => {
      const code = getFirebaseErrorCode(error)
      if (code === 'permission-denied') {
        setUiError('Permissions Firestore insuffisantes pour lire le calendrier de ce voyage.')
      } else {
        setUiError('Impossible de synchroniser ce calendrier pour le moment.')
      }
    })

    return () => unsubscribe()
  }, [selectedTripId])

  const tripUsers = useMemo(() => {
    const fromData = new Set<string>()

    Object.values(availabilityByDate).forEach((names) => {
      names.forEach((name) => {
        fromData.add(name)
      })
    })

    return [...fromData].sort((a, b) => a.localeCompare(b))
  }, [availabilityByDate])

  const allKnownNames = useMemo(() => {
    const names = new Set(tripUsers)

    if (selectedName) {
      names.add(selectedName)
    }

    return [...names].sort((a, b) => a.localeCompare(b, DATE_LOCALE))
  }, [selectedName, tripUsers])

  const fullyAvailableDates = useMemo(() => {
    if (tripUsers.length === 0) {
      return new Set<string>()
    }

    const everyone = tripUsers
    const matched = Object.entries(availabilityByDate)
      .filter(([, names]) => everyone.every((name) => names.includes(name)))
      .map(([dateKey]) => dateKey)

    return new Set<string>(matched)
  }, [tripUsers, availabilityByDate])

  const rankedBestDates = useMemo(() => {
    if (tripUsers.length === 0) {
      return [] as Array<{ dateKey: string; count: number; names: string[]; everyoneAvailable: boolean }>
    }

    return Object.entries(availabilityByDate)
      .map(([dateKey, names]) => {
        const uniqueNames = [...new Set(names)].sort((a, b) => a.localeCompare(b, DATE_LOCALE))
        const count = uniqueNames.length
        const everyoneAvailable = count === tripUsers.length

        return {
          dateKey,
          count,
          names: uniqueNames,
          everyoneAvailable,
        }
      })
      .filter((item) => item.count >= 3 || item.everyoneAvailable)
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count
        }
        return a.dateKey.localeCompare(b.dateKey)
      })
  }, [availabilityByDate, tripUsers])

  const days = useMemo(() => calendarDays(currentMonth), [currentMonth])

  const selectedDateInfo = useMemo(() => {
    if (!selectedDateKey) return null
    const names = availabilityByDate[selectedDateKey] ?? []
    const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b, DATE_LOCALE))
    return { dateKey: selectedDateKey, names: sorted, count: sorted.length }
  }, [selectedDateKey, availabilityByDate])

  async function toggleAvailability(dateKey: string): Promise<void> {
    if (!selectedName || !selectedTripId) {
      return
    }

    setIsSyncing(true)

    const dateDocRef = doc(db, 'trips', selectedTripId, 'availability', dateKey)

    try {
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(dateDocRef)
        const existing = snapshot.exists()
          ? ((snapshot.data().names as string[] | undefined) ?? [])
          : []

        const hasName = existing.includes(selectedName)
        const names = hasName
          ? existing.filter((name) => name !== selectedName)
          : [...existing, selectedName]

        transaction.set(
          dateDocRef,
          {
            dateKey,
            names,
          },
          { merge: true },
        )
      })
      setUiError('')
    } catch (error) {
      const code = getFirebaseErrorCode(error)
      if (code === 'permission-denied') {
        setUiError('Permissions Firestore insuffisantes pour modifier les disponibilités.')
      } else {
        setUiError('Impossible de mettre à jour la disponibilité.')
      }
    } finally {
      setIsSyncing(false)
    }
  }

  function chooseName(name: string): void {
    const normalized = name.trim()
    if (!normalized) {
      return
    }

    setSelectedName(normalized)
    localStorage.setItem(STORAGE_NAME_KEY, normalized)
    setPickerCustomName('')
    setIsNameModalDismissed(false)
  }

  async function createTrip(): Promise<void> {
    const normalizedTripName = tripInputName.trim()

    if (!normalizedTripName || !selectedName) {
      return
    }

    try {
      const createdTrip = await addDoc(collection(db, 'trips'), {
        name: normalizedTripName,
        createdBy: selectedName,
        createdAt: serverTimestamp(),
      })

      setTripInputName('')
      setSelectedTripId(createdTrip.id)
      setIsTripModalOpen(false)
      setUiError('')
    } catch (error) {
      const code = getFirebaseErrorCode(error)
      if (code === 'permission-denied') {
        setUiError('Missing or insufficient permissions: autorisez la collection trips dans Firestore Rules.')
      } else {
        setUiError('Impossible de créer le voyage pour le moment.')
      }
    }
  }

  function selectTrip(tripId: string): void {
    setSelectedTripId(tripId)
    setIsTripModalOpen(false)
  }

  async function deleteSelectedTrip(): Promise<void> {
    if (!selectedTrip || selectedTrip.createdBy !== selectedName) {
      return
    }

    const shouldDelete = window.confirm(
      `Supprimer le voyage "${selectedTrip.name}" ? Cette action est irreversible.`,
    )

    if (!shouldDelete) {
      return
    }

    try {
      const availabilityDocs = await getDocs(
        collection(db, 'trips', selectedTrip.id, 'availability'),
      )

      await Promise.all(
        availabilityDocs.docs.map((availabilityDoc) => deleteDoc(availabilityDoc.ref)),
      )

      await deleteDoc(doc(db, 'trips', selectedTrip.id))
      setSelectedTripId(null)
      setIsTripModalOpen(true)
      setUiError('')
    } catch (error) {
      const code = getFirebaseErrorCode(error)
      if (code === 'permission-denied') {
        setUiError('Permissions Firestore insuffisantes pour supprimer ce voyage.')
      } else {
        setUiError('Impossible de supprimer le voyage pour le moment.')
      }
    }
  }

  const showTripModal = hasSelectedName && !showNamePicker && isTripModalOpen

  return (
    <div className="safe-area-bottom mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col px-2 pb-6 pt-2 text-slate-900 sm:max-w-6xl sm:px-6 sm:py-6 lg:px-10">
      {/* Name Picker — bottom sheet on mobile */}
      {showNamePicker ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => {
            const saved = localStorage.getItem(STORAGE_NAME_KEY) ?? ''
            setSelectedName(saved)
            setIsNameModalDismissed(true)
          }}
        >
          <div
            className="max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl bg-white px-5 pb-8 pt-4 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
            <p className="font-['Space_Grotesk'] text-xl font-bold text-slate-900 sm:text-2xl">
              Choisissez votre nom
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Votre nom est enregistré sur cet appareil.
            </p>
            <div className="mt-5">
              <label className="text-sm font-medium text-slate-700" htmlFor="picker-custom-name">
                Entrez votre nom
              </label>
              <input
                className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-300 sm:py-2 sm:text-sm"
                id="picker-custom-name"
                maxLength={20}
                onChange={(e) => setPickerCustomName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') chooseName(pickerCustomName) }}
                placeholder="Votre prénom"
                value={pickerCustomName}
              />
              <button
                className="mt-3 w-full rounded-xl bg-sky-600 py-3 text-base font-semibold text-white active:bg-sky-700 sm:py-2 sm:text-sm sm:hover:bg-sky-700"
                onClick={() => chooseName(pickerCustomName)}
                type="button"
              >
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Trip Picker — bottom sheet on mobile */}
      {showTripModal ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setIsTripModalOpen(false)}
        >
          <div
            className="max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl bg-white px-5 pb-8 pt-4 shadow-2xl sm:max-w-xl sm:rounded-3xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300 sm:hidden" />
            <p className="font-['Space_Grotesk'] text-xl font-bold text-slate-900 sm:text-2xl">
              {trips.length === 0 ? 'Créez votre premier voyage' : 'Choisissez un voyage'}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {trips.length === 0
                ? 'Aucun voyage existe encore. Donnez-lui un nom pour commencer.'
                : 'Sélectionnez un voyage existant ou créez-en un nouveau.'}
            </p>

            {trips.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2 sm:grid sm:grid-cols-2">
                {trips.map((trip) => (
                  <button
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition active:scale-[0.98] active:bg-slate-100 sm:py-2 sm:text-sm sm:hover:bg-slate-100"
                    key={trip.id}
                    onClick={() => selectTrip(trip.id)}
                    type="button"
                  >
                    <p className="font-semibold text-slate-900">{trip.name}</p>
                    <p className="text-xs text-slate-500">Créé par : {trip.createdBy || 'Inconnu'}</p>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-5">
              <label className="text-sm font-medium text-slate-700" htmlFor="trip-name">
                Nom du voyage
              </label>
              <input
                className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-300 sm:py-2 sm:text-sm"
                id="trip-name"
                maxLength={40}
                onChange={(e) => setTripInputName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createTrip() }}
                placeholder="Ex: Week-end à Lisbonne"
                value={tripInputName}
              />
              <button
                className="mt-3 w-full rounded-xl bg-sky-600 py-3 text-base font-semibold text-white active:bg-sky-700 sm:py-2 sm:text-sm sm:hover:bg-sky-700"
                onClick={() => void createTrip()}
                type="button"
              >
                Créer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Sticky compact header */}
      <header className="sticky top-0 z-10 rounded-2xl border border-slate-200/80 bg-white/95 p-3 shadow-md backdrop-blur-md sm:static sm:rounded-3xl sm:p-6 sm:shadow-xl">
        {uiError ? (
          <p className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:mb-4 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm">
            {uiError}
          </p>
        ) : null}

        <div className="flex items-start justify-between gap-2 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-['Space_Grotesk'] text-base font-bold leading-tight text-slate-900 sm:text-3xl">
              {selectedTrip ? selectedTrip.name : 'Calendrier voyage'}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 sm:mt-1 sm:text-sm">
              {hasSelectedName ? (
                <>Connecté : <span className="font-semibold text-slate-700">{selectedName}</span></>
              ) : (
                'Non identifié'
              )}
            </p>
            <p className="mt-1 hidden text-sm text-slate-500 sm:block">
              Touchez les dates pour ajouter ou retirer vos disponibilités.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-600 active:bg-slate-100 sm:px-3 sm:text-sm sm:hover:bg-slate-100"
              onClick={() => {
                setPickerCustomName(selectedName)
                setSelectedName('')
                setIsNameModalDismissed(false)
              }}
              type="button"
            >
              Profil
            </button>
            <button
              className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-600 active:bg-slate-100 sm:px-3 sm:text-sm sm:hover:bg-slate-100"
              onClick={() => setIsTripModalOpen(true)}
              type="button"
            >
              Voyage
            </button>
            {selectedTrip && selectedTrip.createdBy === selectedName ? (
              <button
                className="rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs font-medium text-rose-600 active:bg-rose-100 sm:px-3 sm:text-sm sm:hover:bg-rose-100"
                onClick={() => void deleteSelectedTrip()}
                type="button"
              >
                <span className="sm:hidden">✕</span>
                <span className="hidden sm:inline">Supprimer</span>
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {/* Calendar */}
      <main className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-lg backdrop-blur-sm sm:mt-6 sm:rounded-3xl sm:p-6 sm:shadow-xl">
        {!selectedTrip ? (
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
            Sélectionnez ou créez un voyage pour afficher le calendrier.
          </p>
        ) : null}

        <div className="mb-3 flex items-center justify-between">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-lg font-bold text-slate-600 active:bg-slate-100 sm:h-auto sm:w-auto sm:px-3 sm:py-2 sm:text-sm sm:hover:bg-slate-100"
            onClick={() =>
              setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
            }
            type="button"
          >
            <span className="sm:hidden">‹</span>
            <span className="hidden sm:inline">Précédent</span>
          </button>
          <p className="font-['Space_Grotesk'] text-sm font-bold capitalize text-slate-900 sm:text-xl">
            {monthLabel(currentMonth)}
          </p>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-lg font-bold text-slate-600 active:bg-slate-100 sm:h-auto sm:w-auto sm:px-3 sm:py-2 sm:text-sm sm:hover:bg-slate-100"
            onClick={() =>
              setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
            }
            type="button"
          >
            <span className="sm:hidden">›</span>
            <span className="hidden sm:inline">Suivant</span>
          </button>
        </div>

        <div className="grid grid-cols-7 gap-[3px] text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400 sm:gap-2 sm:text-sm sm:text-slate-500">
          {WEEKDAY_LABELS.map((label) => (
            <div className="pb-1" key={label}>
              <span className="sm:hidden">{label.charAt(0)}</span>
              <span className="hidden sm:inline">{label}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0 sm:gap-1">
          {days.map((day) => {
            const key = dateKeyFor(day)
            const names = availabilityByDate[key] ?? []
            const sortedNames = [...names].sort((a, b) => a.localeCompare(b, DATE_LOCALE))
            const inCurrentMonth = day.getMonth() === currentMonth.getMonth()
            const selected = selectedName ? names.includes(selectedName) : false
            const everyoneAvailable = fullyAvailableDates.has(key)
            const canToggle = inCurrentMonth && !!selectedName && !!selectedTripId && !isSyncing
            const isViewing = selectedDateKey === key

            return (
              <button
                className={[
                  'group relative flex aspect-square min-h-[52px] flex-col sm:rounded-none sm:rounded-xl  p-1 text-left transition-transform active:scale-[0.96] sm:min-h-24',
                  inCurrentMonth
                    ? 'border border-slate-200 bg-white sm:hover:border-sky-300 sm:hover:bg-sky-50'
                    : 'bg-slate-50/60 text-slate-400',
                  selected ? 'border-2 border-inset border-sky-500 z-10' : '',
                  everyoneAvailable ? 'border-emerald-300 bg-emerald-50' : '',
                  isViewing && inCurrentMonth ? 'border-sky-400' : '',
                ].filter(Boolean).join(' ')}
                disabled={!inCurrentMonth}
                key={key}
                onClick={() => {
                  setSelectedDateKey(key)
                  if (canToggle) {
                    void toggleAvailability(key)
                  }
                }}
                type="button"
              >
                <span className={`text-[11px] font-semibold leading-none sm:text-sm  ring-inset ring-inset ? 'text-sky-600' : ''}`}>
                  {day.getDate()}
                </span>
                {sortedNames.length > 0 ? (
                  <div className="mt-auto flex flex-wrap gap-[2px] pt-0.5 sm:gap-1">
                    {sortedNames.slice(0, 6).map((name) => (
                      <span
                        className={`h-[6px] w-[6px] rounded-full sm:h-2.5 sm:w-2.5 ${colorForName(name)}`}
                        key={`${key}-${name}`}
                      />
                    ))}
                    {sortedNames.length > 6 ? (
                      <span className="text-[7px] leading-none text-slate-400">+{sortedNames.length - 6}</span>
                    ) : null}
                  </div>
                ) : null}
                {everyoneAvailable ? (
                  <span className="mt-0.5 text-[7px] font-bold uppercase leading-none tracking-wide text-emerald-600 sm:mt-1 sm:text-[10px]">
                    Tous ✓
                  </span>
                ) : null}
                {inCurrentMonth && sortedNames.length > 0 ? (
                  <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-40 -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-2 text-xs text-slate-700 shadow-xl sm:group-hover:block">
                    <p className="font-semibold text-slate-900">Présents ({sortedNames.length})</p>
                    <p className="mt-1 line-clamp-4">{sortedNames.join(', ')}</p>
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>
      </main>

      {/* Selected date detail */}
      {selectedDateInfo && selectedDateInfo.count > 0 ? (
        <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50/80 p-3 sm:mt-4 sm:rounded-3xl sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">
              {friendlyDate(selectedDateInfo.dateKey)} · {selectedDateInfo.count} présent{selectedDateInfo.count > 1 ? 's' : ''}
              {fullyAvailableDates.has(selectedDateInfo.dateKey) ? (
                <span className="ml-1.5 text-emerald-600">· Tous dispo ✓</span>
              ) : null}
            </p>
            <button
              className="rounded-lg p-1 text-slate-400 active:bg-slate-200 sm:hover:bg-slate-200"
              onClick={() => setSelectedDateKey(null)}
              type="button"
            >
              ✕
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-600">{selectedDateInfo.names.join(', ')}</p>
        </div>
      ) : null}

      {/* Legend */}
      <section className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm sm:mt-6 sm:rounded-3xl sm:p-5 sm:shadow-lg">
        <p className="font-['Space_Grotesk'] text-sm font-semibold text-slate-900 sm:text-lg">Légende</p>
        <div className="hide-scrollbar mt-2 flex gap-2 overflow-x-auto pb-1 sm:mt-3 sm:flex-wrap">
          {allKnownNames.map((name) => (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs sm:gap-2 sm:px-3 sm:text-sm"
              key={name}
            >
              <span className={`h-2 w-2 rounded-full sm:h-2.5 sm:w-2.5 ${colorForName(name)}`} />
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* Best dates */}
      <section className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm sm:mt-4 sm:rounded-3xl sm:p-5 sm:shadow-lg">
        <p className="font-['Space_Grotesk'] text-sm font-semibold text-slate-900 sm:text-lg">Meilleures dates</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {rankedBestDates.map((item) => (
            <button
              className="flex w-full items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-left text-xs active:bg-emerald-100 sm:w-auto sm:justify-start sm:gap-2 sm:rounded-full sm:py-1 sm:text-sm sm:hover:bg-emerald-100"
              key={item.dateKey}
              onClick={() => setSelectedDateKey(item.dateKey)}
              type="button"
            >
              <span className="font-semibold text-emerald-800">
                {friendlyDate(item.dateKey)}
              </span>
              <span className="flex items-center gap-1.5 text-emerald-700">
                <span>{item.count} pers.</span>
                {item.everyoneAvailable ? <span className="text-emerald-600">✓</span> : null}
              </span>
            </button>
          ))}
          {rankedBestDates.length === 0 ? (
            <p className="py-1 text-xs text-slate-500 sm:text-sm">
              {tripUsers.length === 0
                ? 'Aucun utilisateur actif dans ce voyage.'
                : 'Aucune date ne respecte le minimum (3 pers. ou tous dispo).'}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

export default App
