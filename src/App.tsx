import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
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

function friendlyDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(DATE_LOCALE, {
    month: 'short',
    day: 'numeric',
  })
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

  const hasSelectedName = selectedName.trim().length > 0
  const showNamePicker = !hasSelectedName && !isNameModalDismissed

  const selectedTrip = useMemo(() => {
    return trips.find((trip) => trip.id === selectedTripId) ?? null
  }, [selectedTripId, trips])

  const monthWindow = useMemo(() => {
    const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1)
    const lastDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0)
    return {
      startKey: dateKeyFor(firstDay),
      endKey: dateKeyFor(lastDay),
    }
  }, [currentMonth])

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

    const q = query(
      collection(db, 'trips', selectedTripId, 'availability'),
      where('dateKey', '>=', monthWindow.startKey),
      where('dateKey', '<=', monthWindow.endKey),
    )

    const unsubscribe = onSnapshot(q, (snapshot) => {
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
  }, [monthWindow.endKey, monthWindow.startKey, selectedTripId])

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

  const days = useMemo(() => calendarDays(currentMonth), [currentMonth])

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
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 text-slate-900 sm:px-6 lg:px-10">
      {showNamePicker ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="mb-2 flex justify-end">
              <button
                className="rounded-xl border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                onClick={() => setIsNameModalDismissed(true)}
                type="button"
              >
                Fermer
              </button>
            </div>
            <p className="font-['Space_Grotesk'] text-2xl font-bold text-slate-900">Choisissez votre nom</p>
            <p className="mt-1 text-sm text-slate-600">Votre nom est enregistré sur cet appareil.</p>

            <div className="mt-4 space-y-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="picker-custom-name">
                Entrez votre nom
              </label>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-offset-2 focus:border-sky-500 focus:ring-2 focus:ring-sky-300"
                  id="picker-custom-name"
                  maxLength={20}
                  onChange={(event) => setPickerCustomName(event.target.value)}
                  placeholder="Entrez votre nom"
                  value={pickerCustomName}
                />
                <button
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700"
                  onClick={() => chooseName(pickerCustomName)}
                  type="button"
                >
                  Enregistrer
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showTripModal ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="mb-2 flex justify-end">
              <button
                className="rounded-xl border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                onClick={() => setIsTripModalOpen(false)}
                type="button"
              >
                Fermer
              </button>
            </div>
            <p className="font-['Space_Grotesk'] text-2xl font-bold text-slate-900">
              {trips.length === 0 ? 'Créez votre premier voyage' : 'Choisissez un voyage'}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {trips.length === 0
                ? 'Aucun voyage existe encore. Donnez-lui un nom pour commencer.'
                : 'Sélectionnez un voyage existant ou créez-en un nouveau.'}
            </p>

            {trips.length > 0 ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {trips.map((trip) => (
                  <button
                    className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium transition hover:-translate-y-0.5 hover:bg-slate-100"
                    key={trip.id}
                    onClick={() => selectTrip(trip.id)}
                    type="button"
                  >
                    <p className="font-semibold text-slate-900">{trip.name}</p>
                    <p className="text-xs text-slate-600">Créé par : {trip.createdBy || 'Inconnu'}</p>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="trip-name">
                Nom du voyage
              </label>
              <div className="flex gap-2">
                <input
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-offset-2 focus:border-sky-500 focus:ring-2 focus:ring-sky-300"
                  id="trip-name"
                  maxLength={40}
                  onChange={(event) => setTripInputName(event.target.value)}
                  placeholder="Ex: Week-end à Lisbonne"
                  value={tripInputName}
                />
                <button
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700"
                  onClick={() => void createTrip()}
                  type="button"
                >
                  Créer
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <header className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl backdrop-blur-sm sm:p-6">
        {uiError ? (
          <p className="mb-4 rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {uiError}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-['Space_Grotesk'] text-3xl font-bold leading-tight text-slate-900 sm:text-4xl">
              Disponibilités pour un voyage entre amis
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Touchez les dates pour ajouter ou retirer vos disponibilités. Les mises à jour sont synchronisées en temps réel.
            </p>
          </div>

          <div className="space-y-3 sm:text-right">
            <p className="text-sm text-slate-600">
              Vous êtes :{' '}
              <span className="font-semibold text-slate-900">{selectedName || 'Non sélectionné'}</span>
            </p>
            <p className="text-sm text-slate-600">
              Voyage :{' '}
              <span className="font-semibold text-slate-900">
                {selectedTrip ? selectedTrip.name : 'Aucun voyage sélectionné'}
              </span>
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium transition hover:bg-slate-50"
                onClick={() => setIsTripModalOpen(true)}
                type="button"
              >
                Changer de voyage
              </button>
              {selectedTrip && selectedTrip.createdBy === selectedName ? (
                <button
                  className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-100"
                  onClick={() => void deleteSelectedTrip()}
                  type="button"
                >
                  Supprimer le voyage
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <main className="mt-6 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-xl backdrop-blur-sm sm:p-6">
        {!selectedTrip ? (
          <p className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Sélectionnez ou créez un voyage pour afficher le calendrier.
          </p>
        ) : null}

        <div className="mb-4 flex items-center justify-between">
          <button
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold transition hover:bg-slate-100"
            onClick={() =>
              setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
            }
            type="button"
          >
            Précédent
          </button>
          <p className="font-['Space_Grotesk'] text-xl font-bold text-slate-900">{monthLabel(currentMonth)}</p>
          <button
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold transition hover:bg-slate-100"
            onClick={() =>
              setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
            }
            type="button"
          >
            Suivant
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 sm:gap-2 sm:text-sm">
          {WEEKDAY_LABELS.map((label) => (
            <div className="pb-1" key={label}>
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {days.map((day) => {
            const key = dateKeyFor(day)
            const names = availabilityByDate[key] ?? []
            const inCurrentMonth = day.getMonth() === currentMonth.getMonth()
            const selected = selectedName ? names.includes(selectedName) : false
            const everyoneAvailable = fullyAvailableDates.has(key)

            return (
              <button
                className={`min-h-20 rounded-2xl border p-2 text-left transition sm:min-h-24 ${
                  inCurrentMonth
                    ? 'border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50'
                    : 'border-transparent bg-slate-100/60 text-slate-400'
                } ${selected ? 'ring-2 ring-sky-400 ring-offset-1' : ''} ${
                  everyoneAvailable ? 'border-emerald-300 bg-emerald-50' : ''
                }`}
                disabled={!inCurrentMonth || !selectedName || !selectedTripId || isSyncing}
                key={key}
                onClick={() => void toggleAvailability(key)}
                type="button"
              >
                <p className="text-sm font-semibold">{day.getDate()}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {names.map((name) => (
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${colorForName(name)}`}
                      key={`${key}-${name}`}
                      title={name}
                    />
                  ))}
                </div>
                {everyoneAvailable ? (
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 sm:text-[11px]">
                    Tous dispo
                  </p>
                ) : null}
              </button>
            )
          })}
        </div>
      </main>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-lg sm:p-5">
        <p className="font-['Space_Grotesk'] text-lg font-semibold text-slate-900">Légende</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {allKnownNames.map((name) => (
            <span
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm"
              key={name}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${colorForName(name)}`} />
              {name}
            </span>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-lg sm:p-5">
        <p className="font-['Space_Grotesk'] text-lg font-semibold text-slate-900">Meilleures dates de voyage pour {currentMonth.toLocaleDateString('fr-FR', { month: 'long' })}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {[...fullyAvailableDates]
            .sort((a, b) => a.localeCompare(b))
            .map((dateKey) => (
              <span
                className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800"
                key={dateKey}
              >
                {friendlyDate(dateKey)}
              </span>
            ))}
          {fullyAvailableDates.size === 0 ? (
            <p className="text-sm text-slate-600">
              {tripUsers.length === 0
                ? 'Aucun utilisateur actif dans ce voyage pour le moment.'
                : 'Aucune date commune pour tout le monde ce mois-ci.'}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

export default App
