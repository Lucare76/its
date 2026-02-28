import React, { useEffect, useRef, useState } from 'react'

export default function App(){
  const [theme, setTheme] = useState(() => localStorage.getItem('its_theme') || 'light')
  const [health, setHealth] = useState(null)
  const [bookings, setBookings] = useState([])
  const [token, setToken] = useState(localStorage.getItem('its_token') || '')
  const [refreshToken, setRefreshToken] = useState(localStorage.getItem('its_refresh') || '')
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('its_user')
    return raw ? JSON.parse(raw) : null
  })
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })
  const [forgotEmail, setForgotEmail] = useState('')
  const [resetForm, setResetForm] = useState({ token: '', newPassword: '' })
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [form, setForm] = useState({ service: 'transfer', passengers: 1, hotelId: '', travelMode: '', travelRef: '', arrivalAt: '', priceTotal: '' })
  const [hotels, setHotels] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [hotelForm, setHotelForm] = useState({ name: '', address: '', latitude: '', longitude: '' })
  const [osmImportForm, setOsmImportForm] = useState({ limit: '' })
  const [osmImportResult, setOsmImportResult] = useState(null)
  const [stopPlanner, setStopPlanner] = useState({ date: '', vehicle: '' })
  const [orderedBusStops, setOrderedBusStops] = useState([])
  const [portShuttleForm, setPortShuttleForm] = useState({ date: '', port: 'ISCHIA_PORTO', service: 'transfer' })
  const [portShuttleStops, setPortShuttleStops] = useState([])
  const [groupingFilters, setGroupingFilters] = useState({ date: '', mode: 'SHIP', windowMinutes: 30 })
  const [groupedArrivals, setGroupedArrivals] = useState([])
  const [groupDispatchForm, setGroupDispatchForm] = useState({ scheduledAt: '', vehicle: '', driverName: '', notes: '' })
  const [statements, setStatements] = useState([])
  const [statementsLoading, setStatementsLoading] = useState(false)
  const [generateStatementsLoading, setGenerateStatementsLoading] = useState(false)
  const [statementExportLoadingId, setStatementExportLoadingId] = useState('')
  const [statementEmailLoadingId, setStatementEmailLoadingId] = useState('')
  const [auditLogs, setAuditLogs] = useState([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditFilters, setAuditFilters] = useState({ action: '', entityType: '', dateFrom: '', dateTo: '' })
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 })
  const [notifications, setNotifications] = useState([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notificationFilters, setNotificationFilters] = useState({ type: 'all', unreadOnly: false })
  const [dispatchAvailability, setDispatchAvailability] = useState({ checked: false, ok: null, message: '' })
  const [groupDispatchAvailability, setGroupDispatchAvailability] = useState({ checked: false, ok: null, message: '' })
  const [vehicleBlocks, setVehicleBlocks] = useState([])
  const [vehicleBlockForm, setVehicleBlockForm] = useState({ vehicleId: '', startAt: '', endAt: '', reason: '' })
  const [filters, setFilters] = useState({ status: '', service: '', dateFrom: '', dateTo: '' })
  const [sort, setSort] = useState({ sortBy: 'createdAt', sortDir: 'desc' })
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 })
  const [kpi, setKpi] = useState({ total: 0, pending: 0, confirmed: 0, rejected: 0, today: 0 })
  const [kpiTrend, setKpiTrend] = useState([])
  const [kpiTrendLoading, setKpiTrendLoading] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [importPreviewLoading, setImportPreviewLoading] = useState(false)
  const [importSkipDuplicates, setImportSkipDuplicates] = useState(true)
  const [dispatchPlans, setDispatchPlans] = useState([])
  const [unplannedBookings, setUnplannedBookings] = useState([])
  const [dispatchForm, setDispatchForm] = useState({ bookingId: '', scheduledAt: '', vehicle: '', driverName: '', notes: '' })
  const [dispatchFilters, setDispatchFilters] = useState({ date: '' })
  const [bookingsLoading, setBookingsLoading] = useState(false)
  const [kpiLoading, setKpiLoading] = useState(false)
  const [dispatchLoading, setDispatchLoading] = useState(false)
  const [toast, setToast] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [forgotLoading, setForgotLoading] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [approveLoadingId, setApproveLoadingId] = useState(null)
  const [rejectLoadingId, setRejectLoadingId] = useState(null)
  const [importLoading, setImportLoading] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)
  const [dispatchSubmitLoading, setDispatchSubmitLoading] = useState(false)
  const [dispatchUpdateLoadingId, setDispatchUpdateLoadingId] = useState(null)
  const [dragHoverSlot, setDragHoverSlot] = useState({ vehicle: '', slot: '' })
  const [hotelSubmitLoading, setHotelSubmitLoading] = useState(false)
  const [osmImportLoading, setOsmImportLoading] = useState(false)
  const [stopPlannerLoading, setStopPlannerLoading] = useState(false)
  const [portShuttleLoading, setPortShuttleLoading] = useState(false)
  const [hotelAssignLoadingId, setHotelAssignLoadingId] = useState(null)
  const [groupingLoading, setGroupingLoading] = useState(false)
  const [groupDispatchLoadingKey, setGroupDispatchLoadingKey] = useState('')
  const [dispatchAvailabilityLoading, setDispatchAvailabilityLoading] = useState(false)
  const [groupDispatchAvailabilityLoading, setGroupDispatchAvailabilityLoading] = useState(false)
  const [vehicleBlockLoading, setVehicleBlockLoading] = useState(false)
  const [vehicleBlockSubmitLoading, setVehicleBlockSubmitLoading] = useState(false)
  const [vehicleBlockDeleteId, setVehicleBlockDeleteId] = useState(null)
  const [activeView, setActiveView] = useState(token ? 'home' : 'auth')
  const [todayDigestLoading, setTodayDigestLoading] = useState(false)
  const [todayDigest, setTodayDigest] = useState({ arrivals: [], departures: [], pendingToday: 0 })
  const [schemaReady, setSchemaReady] = useState(true)
  const bookingsRequestRef = useRef(0)
  const todayDigestRequestRef = useRef(0)
  const bookingsAbortRef = useRef(null)
  const todayDigestAbortRef = useRef(null)
  const groupedArrivalsAbortRef = useRef(null)

  useEffect(()=>{
    fetch('/api/health')
      .then(r => {
        const header = r.headers.get('X-Schema-Ready')
        if (header === 'false') setSchemaReady(false)
        return r.json()
      })
      .then(setHealth)
      .catch(() => setHealth({ ok: false }))

    const params = new URLSearchParams(window.location.search)
    const tokenFromUrl = params.get('resetToken')
    if (tokenFromUrl) {
      setResetForm(prev => ({ ...prev, token: tokenFromUrl }))
      window.history.replaceState({}, '', window.location.pathname)
    }
  },[])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('its_theme', theme)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(timer)
  }, [toast])

  function showToast(message, type = 'info'){
    setToast({ id: Date.now(), message, type })
  }

  function addNotification(payload){
    setNotifications(prev => {
      const next = [
        {
          id: payload.id || Date.now(),
          type: payload.type || 'INFO',
          message: payload.message || payload.type || 'Notifica',
          details: payload.reason || payload.details || null,
          createdAt: payload.createdAt || new Date().toISOString(),
          read: false,
        },
        ...prev,
      ]
      return next.slice(0, 50)
    })
  }

  function performLogout(){
    if (refreshToken) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {})
    }
    localStorage.removeItem('its_token')
    localStorage.removeItem('its_refresh')
    localStorage.removeItem('its_user')
    setToken('')
    setRefreshToken('')
    setUser(null)
    setBookings([])
    setNotifications([])
    setNotificationsOpen(false)
  }

  function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function toOffsetISOString(value){
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    const offsetMinutes = -date.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMinutes)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    const localIso = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
    return `${localIso}${sign}${hh}:${mm}`
  }

  async function fetchJsonWithRetry(url, options = {}, retryOptions = {}){
    const { retries = 1, retryDelay = 350 } = retryOptions
    let attempt = 0
    while (true) {
      try {
        const response = await fetch(url, options)
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok && response.status >= 500 && attempt < retries) {
          attempt += 1
          await sleep(retryDelay)
          continue
        }
        return { response, data }
      } catch (err) {
        if (attempt >= retries) throw err
        attempt += 1
        await sleep(retryDelay)
      }
    }
  }

  function getErrorMessage(data, fallback){
    return data?.error || data?.message || fallback
  }

  async function refreshAccessToken(){
    if (!refreshToken) return false
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.token) return false
      localStorage.setItem('its_token', data.token)
      setToken(data.token)
      if (data.refreshToken) {
        localStorage.setItem('its_refresh', data.refreshToken)
        setRefreshToken(data.refreshToken)
      }
      return true
    } catch {
      return false
    }
  }

  async function apiJson(url, options = {}, apiOptions = {}){
    const {
      retries = 1,
      retryDelay = 350,
      toastOnError = true,
      errorMessage = 'Errore richiesta',
      handleUnauthorized = true,
      retryOnUnauthorized = true,
    } = apiOptions
    try {
      const { response, data } = await fetchJsonWithRetry(url, options, { retries, retryDelay })
      if (handleUnauthorized && response.status === 401) {
        if (retryOnUnauthorized) {
          const refreshed = await refreshAccessToken()
          if (refreshed) {
            const nextOptions = {
              ...options,
              headers: {
                ...(options.headers || {}),
                Authorization: `Bearer ${localStorage.getItem('its_token') || ''}`,
              },
            }
            return apiJson(url, nextOptions, { ...apiOptions, retryOnUnauthorized: false })
          }
        }
        performLogout()
        if (toastOnError) showToast('Sessione scaduta, accedi di nuovo', 'error')
        return { ok: false, data, response, unauthorized: true }
      }
      if (!response.ok) {
        if (toastOnError) showToast(getErrorMessage(data, errorMessage), 'error')
        return { ok: false, data, response }
      }
      return { ok: true, data, response }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { ok: false, data: null, response: null, aborted: true }
      }
      if (toastOnError) showToast(errorMessage, 'error')
      return { ok: false, data: null, response: null }
    }
  }

  const portOptions = [
    { id: 'ISCHIA_PORTO', name: 'Ischia Porto' },
    { id: 'CASAMICCIOLA', name: 'Casamicciola' },
    { id: 'FORIO', name: 'Forio' },
    { id: 'LACCO_AMENO', name: 'Lacco Ameno' },
    { id: 'SANT_ANGELO', name: "Sant'Angelo" },
  ]

  function buildFilterQuery(options = {}){
    const includePaging = options.includePaging !== false
    const activeFilters = options.filters || filters
    const nextPage = options.page ?? pagination.page
    const nextPageSize = options.pageSize ?? pagination.pageSize
    const nextSortBy = options.sortBy ?? sort.sortBy
    const nextSortDir = options.sortDir ?? sort.sortDir

    const params = new URLSearchParams()
    if (activeFilters.status) params.set('status', activeFilters.status)
    if (activeFilters.service) params.set('service', activeFilters.service)
    if (activeFilters.dateFrom) params.set('dateFrom', activeFilters.dateFrom)
    if (activeFilters.dateTo) params.set('dateTo', activeFilters.dateTo)
    if (nextSortBy) params.set('sortBy', nextSortBy)
    if (nextSortDir) params.set('sortDir', nextSortDir)
    if (includePaging) {
      params.set('page', String(nextPage))
      params.set('pageSize', String(nextPageSize))
    }
    const query = params.toString()
    return query ? `?${query}` : ''
  }

  function buildAuditQuery(options = {}){
    const includePaging = options.includePaging !== false
    const activeFilters = options.filters || auditFilters
    const nextPage = options.page ?? auditPagination.page
    const nextPageSize = options.pageSize ?? auditPagination.pageSize

    const params = new URLSearchParams()
    if (activeFilters.action) params.set('action', activeFilters.action)
    if (activeFilters.entityType) params.set('entityType', activeFilters.entityType)
    if (activeFilters.dateFrom) params.set('dateFrom', activeFilters.dateFrom)
    if (activeFilters.dateTo) params.set('dateTo', activeFilters.dateTo)
    if (includePaging) {
      params.set('page', String(nextPage))
      params.set('pageSize', String(nextPageSize))
    }
    const query = params.toString()
    return query ? `?${query}` : ''
  }

  async function loadBookings(authToken = token, options = {}){
    if (!authToken) return
    const query = buildFilterQuery(options)
    const requestId = ++bookingsRequestRef.current
    if (bookingsAbortRef.current) {
      bookingsAbortRef.current.abort()
    }
    const controller = new AbortController()
    bookingsAbortRef.current = controller
    setBookingsLoading(true)
    try {
      const { ok, data, aborted } = await apiJson(`/api/bookings${query}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      }, {
        errorMessage: 'Errore caricamento prenotazioni',
        retries: 1,
        toastOnError: false,
      })
      if (requestId !== bookingsRequestRef.current) return
      if (!ok) {
        if (aborted) return
        showToast('Errore caricamento prenotazioni', 'error')
        return
      }
      if (Array.isArray(data)) {
        setBookings(data)
        setPagination(prev => ({ ...prev, total: data.length, totalPages: 1 }))
        return
      }
      setBookings(data.items || [])
      setPagination({
        page: data.page || 1,
        pageSize: data.pageSize || 10,
        total: data.total || 0,
        totalPages: data.totalPages || 1,
      })
    } finally {
      if (requestId === bookingsRequestRef.current) {
        setBookingsLoading(false)
      }
    }
  }

  async function loadKpi(authToken = token){
    if (!authToken) return
    setKpiLoading(true)
    try {
      const { ok, data } = await apiJson('/api/bookings/kpi', {
        headers: { Authorization: `Bearer ${authToken}` },
      }, {
        errorMessage: 'Errore caricamento KPI',
        retries: 1,
      })
      if (!ok || !data) return
      setKpi(data)
    } finally {
      setKpiLoading(false)
    }
  }

  async function loadKpiTrend(authToken = token, days = 14){
    if (!authToken) return
    setKpiTrendLoading(true)
    try {
      const { ok, data } = await apiJson(`/api/bookings/kpi/trend?days=${days}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }, {
        errorMessage: 'Errore caricamento trend KPI',
        retries: 1,
      })
      if (!ok) return
      setKpiTrend(Array.isArray(data.items) ? data.items : [])
    } finally {
      setKpiTrendLoading(false)
    }
  }

  async function loadHotels(authToken = token){
    if (!authToken) return
    const { ok, data } = await apiJson('/api/hotels', {
      headers: { Authorization: `Bearer ${authToken}` },
    }, {
      errorMessage: 'Errore caricamento hotel',
      retries: 1,
    })
    if (!ok) return
    setHotels(Array.isArray(data) ? data : [])
  }

  async function loadVehicles(authToken = token){
    if (!authToken) return
    const { ok, data } = await apiJson('/api/vehicles', {
      headers: { Authorization: `Bearer ${authToken}` },
    }, {
      errorMessage: 'Errore caricamento flotta',
      retries: 1,
    })
    if (!ok) return
    setVehicles(Array.isArray(data) ? data : [])
  }

  async function loadVehicleBlocks(authToken = token){
    if (!authToken) return
    setVehicleBlockLoading(true)
    try {
      const { ok, data } = await apiJson('/api/vehicles/unavailability', {
        headers: { Authorization: `Bearer ${authToken}` },
      }, {
        errorMessage: 'Errore caricamento indisponibilita',
        retries: 1,
      })
      if (!ok) return
      setVehicleBlocks(Array.isArray(data) ? data : [])
    } finally {
      setVehicleBlockLoading(false)
    }
  }

  async function loadDispatchData(authToken = token, options = {}){
    if (!authToken) return
    setDispatchLoading(true)
    try {
      const params = new URLSearchParams()
      const targetDate = options.date ?? dispatchFilters.date
      if (targetDate) {
        params.set('dateFrom', targetDate)
        params.set('dateTo', targetDate)
      }
      const query = params.toString()
      const [plansResult, unplannedResult] = await Promise.all([
        apiJson(`/api/dispatch${query ? `?${query}` : ''}`, { headers: { Authorization: `Bearer ${authToken}` } }, {
          errorMessage: 'Errore caricamento dispatch',
          retries: 1,
          toastOnError: false,
        }),
        apiJson('/api/dispatch/unplanned', { headers: { Authorization: `Bearer ${authToken}` } }, {
          errorMessage: 'Errore caricamento dispatch',
          retries: 1,
          toastOnError: false,
        }),
      ])

      if (!plansResult.ok || !unplannedResult.ok) {
        showToast('Errore caricamento dispatch', 'error')
        return
      }

      const plans = plansResult.data
      const unplanned = unplannedResult.data

      setDispatchPlans(Array.isArray(plans) ? plans : [])
      const nextUnplanned = Array.isArray(unplanned) ? unplanned : []
      setUnplannedBookings(nextUnplanned)

      setDispatchForm(prev => {
        if (prev.bookingId) return prev
        const firstBookingId = nextUnplanned[0]?.id ? String(nextUnplanned[0].id) : ''
        return { ...prev, bookingId: firstBookingId }
      })
    } finally {
      setDispatchLoading(false)
    }
  }

  async function loadStatements(authToken = token){
    if (!authToken || user?.role !== 'OPERATOR') return
    setStatementsLoading(true)
    try {
      const { ok, data } = await apiJson('/api/accounting/statements', {
        headers: { Authorization: `Bearer ${authToken}` },
      }, {
        errorMessage: 'Errore caricamento estratti conto',
        retries: 1,
      })
      if (!ok) return
      setStatements(Array.isArray(data) ? data : [])
    } finally {
      setStatementsLoading(false)
    }
  }

  async function loadAuditLogs(authToken = token, options = {}){
    if (!authToken || user?.role !== 'OPERATOR') return
    const query = buildAuditQuery(options)
    setAuditLoading(true)
    try {
      const { ok, data } = await apiJson(`/api/audit${query}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }, {
        errorMessage: 'Errore caricamento audit',
        retries: 1,
      })
      if (!ok) return
      setAuditLogs(Array.isArray(data.items) ? data.items : [])
      setAuditPagination({
        page: data.page || 1,
        pageSize: data.pageSize || 20,
        total: data.total || 0,
        totalPages: data.totalPages || 1,
      })
    } finally {
      setAuditLoading(false)
    }
  }

  async function exportAuditCsv(){
    const query = buildAuditQuery({ includePaging: false })
    try {
      const response = await fetch(`/api/audit/export.csv${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return showToast('Errore export audit', 'error')

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'audit-export.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      showToast('Export audit completato', 'success')
    } catch {
      showToast('Errore export audit', 'error')
    }
  }

  function getTodayDateString() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  async function loadTodayDigest(authToken = token, role = user?.role){
    if (!authToken) return
    const requestId = ++todayDigestRequestRef.current
    if (todayDigestAbortRef.current) {
      todayDigestAbortRef.current.abort()
    }
    const controller = new AbortController()
    todayDigestAbortRef.current = controller

    const date = getTodayDateString()
    const bookingsParams = new URLSearchParams()
    bookingsParams.set('dateFrom', date)
    bookingsParams.set('dateTo', date)
    bookingsParams.set('page', '1')
    bookingsParams.set('pageSize', '250')
    bookingsParams.set('sortBy', 'createdAt')
    bookingsParams.set('sortDir', 'desc')

    setTodayDigestLoading(true)
    try {
      const { ok, data: bookingsData, aborted } = await apiJson(`/api/bookings?${bookingsParams.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      }, {
        errorMessage: 'Errore caricamento riepilogo giornaliero',
        retries: 1,
        toastOnError: false,
      })
      if (requestId !== todayDigestRequestRef.current) return
      if (!ok) {
        if (aborted) return
        showToast('Errore caricamento riepilogo giornaliero', 'error')
        return
      }
      const bookingItems = Array.isArray(bookingsData)
        ? bookingsData
        : (Array.isArray(bookingsData.items) ? bookingsData.items : [])

      const arrivals = bookingItems
        .filter(booking => booking.arrivalAt)
        .sort((a, b) => new Date(a.arrivalAt) - new Date(b.arrivalAt))
        .slice(0, 8)

      let departures = []
      if (role === 'OPERATOR') {
        const dispatchParams = new URLSearchParams()
        dispatchParams.set('dateFrom', date)
        dispatchParams.set('dateTo', date)

        const { ok: dispatchOk, data: dispatchData } = await apiJson(`/api/dispatch?${dispatchParams.toString()}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }, {
          errorMessage: 'Errore caricamento partenze',
          retries: 1,
          toastOnError: false,
        })

        if (!dispatchOk) {
          showToast('Errore caricamento partenze', 'error')
        } else {
          departures = (Array.isArray(dispatchData) ? dispatchData : [])
            .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
            .slice(0, 8)
        }
      }

      const pendingToday = bookingItems.filter(booking => booking.status === 'PENDING').length
      setTodayDigest({ arrivals, departures, pendingToday })
    } finally {
      if (requestId === todayDigestRequestRef.current) {
        setTodayDigestLoading(false)
      }
    }
  }

  async function generateWeeklyStatements(){
    if (generateStatementsLoading) return
    setGenerateStatementsLoading(true)
    try {
      const { ok, data } = await apiJson('/api/accounting/statements/generate-weekly', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }, {
        errorMessage: 'Errore generazione estratti conto',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore generazione estratti conto', 'error')

      showToast(`Estratti conto generati: creati ${data.created}, aggiornati ${data.updated}`, 'success')
      loadStatements(token)
    } finally {
      setGenerateStatementsLoading(false)
    }
  }

  async function exportStatement(statementId, format){
    if (statementExportLoadingId) return
    setStatementExportLoadingId(`${statementId}-${format}`)
    try {
      const response = await fetch(`/api/accounting/statements/${statementId}/export.${format}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const data = await response.json()
        return showToast(data.error || `Errore export ${format.toUpperCase()}`, 'error')
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `statement-${statementId}.${format}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      showToast(`Export ${format.toUpperCase()} completato`, 'success')
    } finally {
      setStatementExportLoadingId('')
    }
  }

  async function sendStatementEmail(statementId){
    if (statementEmailLoadingId) return
    setStatementEmailLoadingId(String(statementId))
    try {
      const { ok, data } = await apiJson(`/api/accounting/statements/${statementId}/send-email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }, {
        errorMessage: 'Errore invio email estratto',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore invio email estratto', 'error')
      if (!data?.delivered) return showToast('SMTP non configurato', 'error')

      showToast('Email estratto inviata', 'success')
    } finally {
      setStatementEmailLoadingId('')
    }
  }

  useEffect(() => {
    if (!token) return

    apiJson('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }, {
      errorMessage: 'Errore profilo',
      retries: 1,
      toastOnError: false,
      handleUnauthorized: true,
    }).then(result => {
      if (!result?.ok || !result.data) return
      setUser(result.data)
      localStorage.setItem('its_user', JSON.stringify(result.data))
    })

    loadBookings(token)
    loadKpi(token)
    loadHotels(token)
    loadVehicles(token)
    loadVehicleBlocks(token)
    loadTodayDigest(token, user?.role)
  }, [token])

  useEffect(() => {
    if (!token) return
    const source = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(token)}`)
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.type) {
          const message = getNotificationMessage(payload)
          addNotification({ ...payload, message })
          showToast(message, 'info')
          if (payload.type.startsWith('BOOKING_')) {
            loadKpi(token)
            if (activeView === 'bookings') loadBookings(token)
          }
          if (payload.type.startsWith('DISPATCH_') && activeView === 'dispatch') {
            loadDispatchData(token, { date: dispatchFilters.date })
          }
        }
      } catch {
        // ignore malformed payloads
      }
    }
    source.onerror = () => {
      source.close()
    }
    return () => source.close()
  }, [token, activeView, dispatchFilters.date])

  useEffect(() => {
    if (!token || user?.role !== 'OPERATOR') return
    loadDispatchData(token)
    loadStatements(token)
    loadTodayDigest(token, user?.role)
  }, [token, user?.role])

  useEffect(() => {
    if (!token || user?.role !== 'OPERATOR') return
    if (activeView !== 'audit') return
    loadAuditLogs(token, { page: 1 })
  }, [token, user?.role, activeView])

  useEffect(() => {
    setActiveView(token ? 'home' : 'auth')
  }, [token, user?.role])

  useEffect(() => {
    if (!token) return
    if (activeView !== 'kpi') return
    loadKpiTrend(token, 14)
  }, [token, activeView])

  function persistAuth(nextToken, nextUser, nextRefreshToken){
    localStorage.setItem('its_token', nextToken)
    if (nextRefreshToken) {
      localStorage.setItem('its_refresh', nextRefreshToken)
      setRefreshToken(nextRefreshToken)
    }
    localStorage.setItem('its_user', JSON.stringify(nextUser))
    setToken(nextToken)
    setUser(nextUser)
  }

  function logout(){
    performLogout()
  }

  async function submitAuth(e){
    e.preventDefault()
    if (authLoading) return
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
    const payload = authMode === 'login'
      ? { email: authForm.email, password: authForm.password }
      : { name: authForm.name, email: authForm.email, password: authForm.password }
    setAuthLoading(true)
    try {
      const { ok, data } = await apiJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, {
        errorMessage: 'Operazione non riuscita',
        retries: 1,
        toastOnError: false,
        handleUnauthorized: false,
      })
      if (!ok) return showToast('Operazione non riuscita', 'error')

      if (authMode === 'register') {
        setAuthMode('login')
        showToast('Registrazione completata, effettua l\'accesso', 'success')
        return
      }

      persistAuth(data.token, data.user, data.refreshToken)
      showToast('Accesso eseguito con successo', 'success')
      loadBookings(data.token)
      loadKpi(data.token)
      loadHotels(data.token)
      loadVehicles(data.token)
      loadVehicleBlocks(data.token)
    } finally {
      setAuthLoading(false)
    }
  }

  async function submitForgotPassword(e){
    e.preventDefault()
    if (forgotLoading) return
    setForgotLoading(true)
    try {
      const { ok, data } = await apiJson('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      }, {
        errorMessage: 'Errore recupero password',
        retries: 1,
        toastOnError: false,
        handleUnauthorized: false,
      })
      if (!ok) return showToast(data?.error || 'Errore recupero password', 'error')
      showToast(`Richiesta inviata. Supporto: ${data.supportEmail}`, 'info')
    } finally {
      setForgotLoading(false)
    }
  }

  async function submitResetPassword(e){
    e.preventDefault()
    if (resetLoading) return
    setResetLoading(true)
    try {
      const { ok, data } = await apiJson('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resetForm),
      }, {
        errorMessage: 'Errore reset password',
        retries: 1,
        toastOnError: false,
        handleUnauthorized: false,
      })
      if (!ok) return showToast(data?.error || 'Errore reset password', 'error')
      showToast(data.message || 'Password aggiornata', 'success')
      setResetForm({ token: '', newPassword: '' })
    } finally {
      setResetLoading(false)
    }
  }

  async function submit(e){
    e.preventDefault()
    if (submitLoading) return
    setSubmitLoading(true)
    try {
      const { ok } = await apiJson('/api/bookings',{
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization: `Bearer ${token}`},
        body:JSON.stringify({
          service: form.service,
          passengers: form.passengers,
          hotelId: form.hotelId ? Number(form.hotelId) : null,
          travelMode: form.travelMode || null,
          travelRef: form.travelRef || null,
          arrivalAt: toOffsetISOString(form.arrivalAt),
          priceTotal: form.priceTotal !== '' ? Number(form.priceTotal) : null,
        })
      }, {
        errorMessage: 'Errore creazione prenotazione',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast('Errore creazione prenotazione', 'error')
      showToast('Prenotazione creata con successo', 'success')
      loadBookings(token)
      loadKpi(token)
    } finally {
      setSubmitLoading(false)
    }
  }

  async function approve(id){
    if (approveLoadingId === id) return
    setApproveLoadingId(id)
    try {
      const { ok, data } = await apiJson(`/api/bookings/${id}/approve`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      }, {
        errorMessage: 'Errore approvazione',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore approvazione', 'error')
      showToast('Prenotazione approvata', 'success')
      loadBookings(token)
      loadKpi(token)
      loadDispatchData(token)
    } finally {
      setApproveLoadingId(null)
    }
  }

  async function rejectBooking(id){
    if (rejectLoadingId === id) return
    const reason = window.prompt('Motivo del rifiuto (facoltativo):', '')
    if (reason === null) return
    setRejectLoadingId(id)
    try {
      const { ok, data } = await apiJson(`/api/bookings/${id}/reject`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
      }, {
        errorMessage: 'Errore rifiuto prenotazione',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore rifiuto prenotazione', 'error')
      showToast('Prenotazione rifiutata', 'success')
      loadBookings(token)
      loadKpi(token)
      loadDispatchData(token)
    } finally {
      setRejectLoadingId(null)
    }
  }

  async function resetBooking(id){
    if (rejectLoadingId === id) return
    if (!window.confirm('Ripristinare la prenotazione in stato "In attesa"?')) return
    setRejectLoadingId(id)
    try {
      const { ok, data } = await apiJson(`/api/bookings/${id}/reset`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }, {
        errorMessage: 'Errore ripristino prenotazione',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore ripristino prenotazione', 'error')
      showToast('Prenotazione ripristinata', 'success')
      loadBookings(token)
      loadKpi(token)
      loadDispatchData(token)
    } finally {
      setRejectLoadingId(null)
    }
  }

  async function submitDispatchPlan(e){
    e.preventDefault()
    if (dispatchSubmitLoading) return

    const bookingId = Number(dispatchForm.bookingId)
    const parsedDate = new Date(dispatchForm.scheduledAt)
    if (!bookingId || Number.isNaN(parsedDate.getTime()) || !dispatchForm.vehicle || !dispatchForm.driverName) {
      return showToast('Compila booking, data/ora, mezzo e autista', 'error')
    }

    const availability = await checkVehicleAvailability(dispatchForm.vehicle, dispatchForm.scheduledAt)
    if (!availability.ok) {
      setDispatchAvailability({ checked: true, ok: false, message: availability.message || 'Mezzo non disponibile' })
      return showToast(availability.message || 'Mezzo non disponibile', 'error')
    }
    setDispatchAvailability({ checked: true, ok: true, message: availability.message || 'Mezzo disponibile' })

    setDispatchSubmitLoading(true)
    try {
      const { ok, data } = await apiJson('/api/dispatch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookingId,
          scheduledAt: toOffsetISOString(parsedDate),
          vehicle: dispatchForm.vehicle,
          driverName: dispatchForm.driverName,
          notes: dispatchForm.notes,
        }),
      }, {
        errorMessage: 'Errore pianificazione servizio',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore pianificazione servizio', 'error')

      showToast('Servizio pianificato', 'success')
      setDispatchForm({ bookingId: '', scheduledAt: '', vehicle: '', driverName: '', notes: '' })
      loadBookings(token)
      loadDispatchData(token)
    } finally {
      setDispatchSubmitLoading(false)
    }
  }

  async function submitHotel(e){
    e.preventDefault()
    if (hotelSubmitLoading) return

    const payload = {
      name: hotelForm.name,
      address: hotelForm.address,
      latitude: Number(hotelForm.latitude),
      longitude: Number(hotelForm.longitude),
    }

    if (!payload.name || !payload.address || Number.isNaN(payload.latitude) || Number.isNaN(payload.longitude)) {
      return showToast('Compila nome, indirizzo, latitudine e longitudine', 'error')
    }

    setHotelSubmitLoading(true)
    try {
      const { ok, data } = await apiJson('/api/hotels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }, {
        errorMessage: 'Errore creazione hotel',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore creazione hotel', 'error')

      showToast('Hotel creato con successo', 'success')
      setHotelForm({ name: '', address: '', latitude: '', longitude: '' })
      loadHotels(token)
    } finally {
      setHotelSubmitLoading(false)
    }
  }

  async function importHotelsFromOsm(){
    if (osmImportLoading) return

    const payload = {}
    if (osmImportForm.limit) {
      const limit = Number(osmImportForm.limit)
      if (Number.isNaN(limit) || limit <= 0) {
        return showToast('Il limite deve essere un numero positivo', 'error')
      }
      payload.limit = limit
    }

    setOsmImportLoading(true)
    setOsmImportResult(null)
    try {
      const { ok, data } = await apiJson('/api/hotels/import-osm', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }, {
        errorMessage: 'Errore import OSM',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore import OSM', 'error')

      setOsmImportResult(data)
      showToast(`Import OSM: creati ${data.created}, saltati ${data.skipped}`, 'success')
      loadHotels(token)
    } finally {
      setOsmImportLoading(false)
    }
  }

  async function updateDispatchPlan(planId, vehicle, scheduledAt){
    if (dispatchUpdateLoadingId) return
    setDispatchUpdateLoadingId(planId)
    try {
      const { ok, data } = await apiJson(`/api/dispatch/${planId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vehicle,
          scheduledAt: toOffsetISOString(scheduledAt),
        }),
      }, {
        errorMessage: 'Errore aggiornamento dispatch',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore aggiornamento dispatch', 'error')
      showToast('Dispatch aggiornato', 'success')
      loadDispatchData(token, { date: dispatchFilters.date })
    } finally {
      setDispatchUpdateLoadingId(null)
    }
  }

  async function loadOrderedBusStops(){
    if (stopPlannerLoading) return
    if (!stopPlanner.date) return showToast('Seleziona una data per ordinare le fermate', 'error')

    setStopPlannerLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('date', stopPlanner.date)
      if (stopPlanner.vehicle) params.set('vehicle', stopPlanner.vehicle)

      const { ok, data } = await apiJson(`/api/dispatch/bus/ordered-stops?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      }, {
        errorMessage: 'Errore ordinamento fermate',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore ordinamento fermate', 'error')

      setOrderedBusStops(Array.isArray(data.orderedStops) ? data.orderedStops : [])
      showToast('Fermate bus ordinate con geolocalizzazione', 'success')
    } finally {
      setStopPlannerLoading(false)
    }
  }

  async function loadPortShuttle(){
    if (portShuttleLoading) return
    if (!portShuttleForm.date) return showToast('Seleziona una data per la navetta porto-hotel', 'error')

    setPortShuttleLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('date', portShuttleForm.date)
      params.set('port', portShuttleForm.port)
      if (portShuttleForm.service) params.set('service', portShuttleForm.service)

      const { ok, data } = await apiJson(`/api/dispatch/port-shuttle?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      }, {
        errorMessage: 'Errore navetta porto-hotel',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore navetta porto-hotel', 'error')

      setPortShuttleStops(Array.isArray(data.orderedStops) ? data.orderedStops : [])
      showToast('Navetta porto-hotel aggiornata', 'success')
    } finally {
      setPortShuttleLoading(false)
    }
  }

  async function loadGroupedArrivals(){
    if (groupingLoading) return
    if (!groupingFilters.date) return showToast('Seleziona una data per il raggruppamento', 'error')

    if (groupedArrivalsAbortRef.current) {
      groupedArrivalsAbortRef.current.abort()
    }
    const controller = new AbortController()
    groupedArrivalsAbortRef.current = controller

    setGroupingLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('date', groupingFilters.date)
      params.set('mode', groupingFilters.mode)
      params.set('windowMinutes', String(groupingFilters.windowMinutes || 30))

      const { ok, data, aborted } = await apiJson(`/api/dispatch/grouped-arrivals?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }, {
        errorMessage: 'Errore raggruppamento arrivi',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) {
        if (aborted) return
        return showToast(data?.error || 'Errore raggruppamento arrivi', 'error')
      }

      setGroupedArrivals(Array.isArray(data.groups) ? data.groups : [])
      showToast('Raggruppamento arrivi aggiornato', 'success')
    } finally {
      setGroupingLoading(false)
    }
  }

  async function createDispatchFromGroup(group){
    if (groupDispatchLoadingKey) return

    const bookingIds = Array.isArray(group?.bookings)
      ? group.bookings.map(booking => booking.id).filter(Boolean)
      : []

    if (bookingIds.length === 0) return showToast('Il gruppo non contiene prenotazioni da elaborare', 'error')
    if (!groupDispatchForm.scheduledAt || !groupDispatchForm.vehicle || !groupDispatchForm.driverName) {
      return showToast('Compila data/ora, mezzo e autista per la pianificazione di gruppo', 'error')
    }

    const availability = await checkVehicleAvailability(groupDispatchForm.vehicle, groupDispatchForm.scheduledAt)
    if (!availability.ok) {
      setGroupDispatchAvailability({ checked: true, ok: false, message: availability.message || 'Mezzo non disponibile' })
      return showToast(availability.message || 'Mezzo non disponibile', 'error')
    }
    setGroupDispatchAvailability({ checked: true, ok: true, message: availability.message || 'Mezzo disponibile' })

    const loadingKey = `${group.mode}-${group.travelRef}-${group.bucketStart}`
    setGroupDispatchLoadingKey(loadingKey)

    try {
      const { ok, data } = await apiJson('/api/dispatch/grouped-arrivals/create-dispatch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookingIds,
          scheduledAt: toOffsetISOString(groupDispatchForm.scheduledAt),
          vehicle: groupDispatchForm.vehicle,
          driverName: groupDispatchForm.driverName,
          notes: groupDispatchForm.notes,
        }),
      }, {
        errorMessage: 'Errore creazione pianificazione di gruppo',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore creazione pianificazione di gruppo', 'error')

      showToast(`Pianificazione gruppo: create ${data.created}, saltate ${data.skippedAlreadyPlanned + data.skippedNotConfirmed + data.notFound}`, 'success')
      await loadDispatchData(token)
      await loadGroupedArrivals()
      await loadVehicleBlocks(token)
    } finally {
      setGroupDispatchLoadingKey('')
    }
  }

  async function createVehicleBlock(e){
    e.preventDefault()
    if (vehicleBlockSubmitLoading) return

    if (!vehicleBlockForm.vehicleId || !vehicleBlockForm.startAt || !vehicleBlockForm.endAt) {
      return showToast('Seleziona mezzo, inizio e fine indisponibilità', 'error')
    }

    setVehicleBlockSubmitLoading(true)
    try {
      const { ok, data } = await apiJson(`/api/vehicles/${Number(vehicleBlockForm.vehicleId)}/unavailability`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startAt: toOffsetISOString(vehicleBlockForm.startAt),
          endAt: toOffsetISOString(vehicleBlockForm.endAt),
          reason: vehicleBlockForm.reason,
        }),
      }, {
        errorMessage: 'Errore creazione indisponibilità',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore creazione indisponibilità', 'error')

      showToast('Indisponibilità mezzo salvata', 'success')
      setVehicleBlockForm({ vehicleId: '', startAt: '', endAt: '', reason: '' })
      loadVehicleBlocks(token)
    } finally {
      setVehicleBlockSubmitLoading(false)
    }
  }

  async function deleteVehicleBlock(entryId){
    if (vehicleBlockDeleteId === entryId) return
    setVehicleBlockDeleteId(entryId)
    try {
      const { ok, data } = await apiJson(`/api/vehicles/unavailability/${entryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }, {
        errorMessage: 'Errore eliminazione indisponibilità',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore eliminazione indisponibilità', 'error')

      showToast('Indisponibilità rimossa', 'success')
      loadVehicleBlocks(token)
    } finally {
      setVehicleBlockDeleteId(null)
    }
  }

  async function checkVehicleAvailability(vehicle, scheduledAt){
    if (!vehicle || !scheduledAt) {
      return { ok: false, message: 'Seleziona mezzo e data/ora' }
    }

    const params = new URLSearchParams()
    params.set('vehicle', vehicle)
    params.set('scheduledAt', toOffsetISOString(scheduledAt) || '')

    const { ok, data } = await apiJson(`/api/dispatch/vehicle-availability?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, {
      errorMessage: 'Verifica disponibilità fallita',
      retries: 1,
      toastOnError: false,
    })
    if (!ok) return { ok: false, message: data?.error || 'Verifica disponibilità fallita' }
    return { ok: Boolean(data?.ok), message: data?.message || '' }
  }

  async function checkSingleDispatchAvailability(){
    if (dispatchAvailabilityLoading) return
    setDispatchAvailabilityLoading(true)
    try {
      const result = await checkVehicleAvailability(dispatchForm.vehicle, dispatchForm.scheduledAt)
      setDispatchAvailability({ checked: true, ok: result.ok, message: result.message })
      if (!result.ok) showToast(result.message || 'Mezzo non disponibile', 'error')
      else showToast(result.message || 'Mezzo disponibile', 'success')
    } finally {
      setDispatchAvailabilityLoading(false)
    }
  }

  async function checkGroupDispatchAvailability(){
    if (groupDispatchAvailabilityLoading) return
    setGroupDispatchAvailabilityLoading(true)
    try {
      const result = await checkVehicleAvailability(groupDispatchForm.vehicle, groupDispatchForm.scheduledAt)
      setGroupDispatchAvailability({ checked: true, ok: result.ok, message: result.message })
      if (!result.ok) showToast(result.message || 'Mezzo non disponibile', 'error')
      else showToast(result.message || 'Mezzo disponibile', 'success')
    } finally {
      setGroupDispatchAvailabilityLoading(false)
    }
  }

  async function assignHotelToBooking(bookingId, hotelIdValue){
    if (hotelAssignLoadingId === bookingId) return
    setHotelAssignLoadingId(bookingId)
    try {
      const { ok, data } = await apiJson(`/api/bookings/${bookingId}/hotel`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hotelId: hotelIdValue ? Number(hotelIdValue) : null }),
      }, {
        errorMessage: 'Errore assegnazione hotel',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore assegnazione hotel', 'error')

      showToast('Hotel assegnato alla prenotazione', 'success')
      loadBookings(token)
      loadDispatchData(token)
    } finally {
      setHotelAssignLoadingId(null)
    }
  }

  async function importBookingsFile(){
    if (importLoading) return
    if (!importFile) return showToast('Seleziona un file CSV o PDF', 'error')
    setImportLoading(true)

    try {
      const formData = new FormData()
      formData.append('file', importFile)
      formData.append('skipDuplicates', String(importSkipDuplicates))

      const { ok, data } = await apiJson('/api/bookings/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }, {
        errorMessage: 'Errore import file',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore import file', 'error')

      setImportResult(data)
      showToast(`Import completato: ${data.created} create, ${data.skipped || 0} duplicate, ${data.failed} errori`, 'success')
      loadBookings(token, { page: 1 })
      loadKpi(token)
    } finally {
      setImportLoading(false)
    }
  }

  async function previewImportFile(){
    if (importPreviewLoading) return
    if (!importFile) return showToast('Seleziona un file CSV o PDF', 'error')
    setImportPreviewLoading(true)
    setImportPreview(null)
    try {
      const formData = new FormData()
      formData.append('file', importFile)
      formData.append('skipDuplicates', String(importSkipDuplicates))

      const { ok, data } = await apiJson('/api/bookings/import/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }, {
        errorMessage: 'Errore preview import',
        retries: 1,
        toastOnError: false,
      })
      if (!ok) return showToast(data?.error || 'Errore preview import', 'error')
      setImportPreview(data)
    } finally {
      setImportPreviewLoading(false)
    }
  }

  async function exportBookingsCsv(){
    if (exportLoading) return
    setExportLoading(true)
    const query = buildFilterQuery({ includePaging: false })
    try {
      const response = await fetch(`/api/bookings/export.csv${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return showToast('Errore export CSV', 'error')

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bookings-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      showToast('Export CSV completato', 'success')
    } finally {
      setExportLoading(false)
    }
  }

  async function exportKpiTrendCsv(days = 14){
    try {
      const response = await fetch(`/api/bookings/kpi/trend.csv?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return showToast('Errore export trend KPI', 'error')

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `kpi-trend-${days}d.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      showToast('Export trend KPI completato', 'success')
    } catch {
      showToast('Errore export trend KPI', 'error')
    }
  }

  function applyFilters(){
    loadBookings(token, { page: 1 })
  }

  function showPendingOnly(){
    const next = { ...filters, status: 'PENDING' }
    setFilters(next)
    loadBookings(token, { page: 1, filters: next })
  }

  function goToPendingValidations(){
    setActiveView('bookings')
    showPendingOnly()
  }

  function clearFilters(){
    const next = { status: '', service: '', dateFrom: '', dateTo: '' }
    setFilters(next)
    loadBookings(token, {
      filters: next,
      page: 1,
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
    })
  }

  function applySort(){
    loadBookings(token, { page: 1, sortBy: sort.sortBy, sortDir: sort.sortDir })
  }

  function previousPage(){
    if (pagination.page <= 1) return
    loadBookings(token, { page: pagination.page - 1 })
  }

  function nextPage(){
    if (pagination.page >= pagination.totalPages) return
    loadBookings(token, { page: pagination.page + 1 })
  }

  function changePageSize(value){
    const pageSize = Number(value)
    loadBookings(token, { page: 1, pageSize })
  }

  function applyAuditFilters(){
    loadAuditLogs(token, { page: 1, filters: auditFilters })
  }

  function clearAuditFilters(){
    const next = { action: '', entityType: '', dateFrom: '', dateTo: '' }
    setAuditFilters(next)
    loadAuditLogs(token, { page: 1, filters: next })
  }

  function previousAuditPage(){
    if (auditPagination.page <= 1) return
    loadAuditLogs(token, { page: auditPagination.page - 1 })
  }

  function nextAuditPage(){
    if (auditPagination.page >= auditPagination.totalPages) return
    loadAuditLogs(token, { page: auditPagination.page + 1 })
  }

  function applyDispatchFilters(){
    loadDispatchData(token, { date: dispatchFilters.date })
  }

  function clearDispatchFilters(){
    const next = { date: '' }
    setDispatchFilters(next)
    loadDispatchData(token, { date: '' })
  }

  function getStatusUi(status){
    if (status === 'CONFIRMED') {
      return { icon: '✓', pillClass: 'status-online', rowClass: 'booking-row-confirmed' }
    }
    if (status === 'PENDING') {
      return { icon: '●', pillClass: 'status-offline', rowClass: 'booking-row-pending' }
    }
    if (status === 'REJECTED') {
      return { icon: '✕', pillClass: 'status-rejected', rowClass: 'booking-row-rejected' }
    }
    return { icon: '•', pillClass: 'status-offline', rowClass: 'booking-row-pending' }
  }

  function getStatusLabel(status){
    if (status === 'PENDING') return 'In attesa'
    if (status === 'CONFIRMED') return 'Confermata'
    if (status === 'REJECTED') return 'Rifiutata'
    return status || '-'
  }

  function getSlotKey(dateValue){
    const date = new Date(dateValue)
    if (Number.isNaN(date.getTime())) return ''
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  function buildTimelineSlots(){
    const slots = []
    for (let hour = 6; hour <= 22; hour += 1) {
      slots.push(`${String(hour).padStart(2, '0')}:00`)
      if (hour !== 22) slots.push(`${String(hour).padStart(2, '0')}:30`)
    }
    return slots
  }

  function getNotificationMessage(payload){
    if (payload?.message) return payload.message
    switch (payload?.type) {
      case 'BOOKING_CREATE':
        return `Nuova prenotazione #${payload.bookingId || ''}`.trim()
      case 'BOOKING_APPROVE':
        return `Prenotazione approvata #${payload.bookingId || ''}`.trim()
      case 'BOOKING_REJECT':
        return `Prenotazione rifiutata #${payload.bookingId || ''}`.trim()
      case 'BOOKING_RESET':
        return `Prenotazione ripristinata #${payload.bookingId || ''}`.trim()
      case 'DISPATCH_CREATE':
        return `Dispatch creato #${payload.dispatchId || ''}`.trim()
      case 'DISPATCH_UPDATE':
        return `Dispatch aggiornato #${payload.dispatchId || ''}`.trim()
      case 'DISPATCH_DELETE':
        return `Dispatch eliminato #${payload.dispatchId || ''}`.trim()
      default:
        return payload?.type || 'Notifica'
    }
  }

  function markAllNotificationsRead(){
    setNotifications(prev => prev.map(item => ({ ...item, read: true })))
  }

  const unreadCount = notifications.reduce((acc, item) => acc + (item.read ? 0 : 1), 0)
  const filteredNotifications = notifications.filter(item => {
    if (notificationFilters.unreadOnly && item.read) return false
    if (notificationFilters.type === 'booking') return item.type?.startsWith('BOOKING_')
    if (notificationFilters.type === 'dispatch') return item.type?.startsWith('DISPATCH_')
    return true
  })
  const bookingNotifCount = notifications.filter(item => item.type?.startsWith('BOOKING_')).length
  const dispatchNotifCount = notifications.filter(item => item.type?.startsWith('DISPATCH_')).length

  const navItems = !token
    ? [
        { view: 'auth', label: 'Accesso', icon: 'AC' },
        { view: 'recovery', label: 'Recupero', icon: 'PW' },
      ]
    : [
        { view: 'home', label: 'Panoramica', icon: 'HM' },
        ...(user?.role === 'OPERATOR'
          ? [
              { view: 'operator-tools', label: 'Operatore', icon: 'OP' },
              { view: 'dispatch', label: 'Pianificazione', icon: 'DP' },
              { view: 'hotels', label: 'Hotel', icon: 'HT' },
              { view: 'grouping', label: 'Raggruppa', icon: 'RG' },
              { view: 'fleet', label: 'Flotta', icon: 'FL' },
              { view: 'accounting', label: 'Contabilita', icon: 'EC' },
              { view: 'audit', label: 'Audit', icon: 'AU' },
            ]
          : [
              { view: 'new-booking', label: 'Nuova richiesta', icon: 'NR' },
            ]),
        { view: 'bookings', label: 'Prenotazioni', icon: 'BK' },
        { view: 'profile', label: 'Profilo', icon: 'ME' },
        { view: 'kpi', label: 'Statistiche', icon: 'KP' },
      ]

  const timelineDate = dispatchFilters.date || getTodayDateString()
  const timelineSlots = buildTimelineSlots()
  const timelinePlans = dispatchPlans.filter(plan => {
    if (!plan.scheduledAt) return false
    return new Date(plan.scheduledAt).toISOString().slice(0, 10) === timelineDate
  })

  return (
    <div className="app-shell">
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo">ITS</div>
            <div>
              <strong>Ischia Transfer</strong>
              <span className="sidebar-sub">Centrale operativa</span>
            </div>
          </div>
          <nav className="sidebar-nav">
            {navItems.map(item => (
              <button
                key={item.view}
                type="button"
                className={`sidebar-link ${activeView === item.view ? 'active' : ''}`}
                onClick={() => setActiveView(item.view)}
              >
                <span className="sidebar-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
        {token && user && (
            <div className="sidebar-meta">
              <span>{user.name}</span>
              <span className="muted">{user.role}</span>
            </div>
          )}
          {token && (
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => setActiveView('status')}
            >
              Stato sistema
            </button>
          )}
        </aside>
        <div className="app-container">
        <header className="page-header">
          <div>
            <h1>ITS - Ischia Transfer Service</h1>
            <p className="header-subtitle">Pannello gestione prenotazioni agenzie e operatori</p>
          </div>
          <div className="header-actions">
            <span className={`status-pill status-main ${health?.ok ? 'status-online' : 'status-offline'}`}>
              API {health ? (health.ok ? 'Operativa' : 'Non raggiungibile') : 'Verifica...'}
            </span>
            <button
              type="button"
              className={`btn btn-ghost notif-btn ${notificationsOpen ? 'active' : ''}`}
              onClick={() => {
                const next = !notificationsOpen
                setNotificationsOpen(next)
                if (next) markAllNotificationsRead()
              }}
              aria-label="Notifiche"
            >
              🔔
              {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-theme"
              onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? 'Tema scuro' : 'Tema chiaro'}
            </button>
          </div>
        </header>

        {!schemaReady && (
          <section className="card warning-card" id="section-schema-warning">
            <strong>Schema non sincronizzato</strong>
            <p className="muted">
              Le funzionalità di refresh token e audit log sono in modalità fallback.
              Esegui <code>prisma db push</code> per attivarle in modo persistente.
            </p>
          </section>
        )}

        {token && notificationsOpen && (
          <section className="card notif-panel" id="section-notifications">
            <div className="top-row">
              <h2>Notifiche</h2>
              <div className="actions-row wrap">
                <button className={`btn btn-ghost ${notificationFilters.type === 'all' ? 'active' : ''}`} onClick={() => setNotificationFilters({ ...notificationFilters, type: 'all' })}>
                  Tutte <span className="pill-count">{notifications.length}</span>
                </button>
                <button className={`btn btn-ghost ${notificationFilters.type === 'booking' ? 'active' : ''}`} onClick={() => setNotificationFilters({ ...notificationFilters, type: 'booking' })}>
                  Booking <span className="pill-count">{bookingNotifCount}</span>
                </button>
                <button className={`btn btn-ghost ${notificationFilters.type === 'dispatch' ? 'active' : ''}`} onClick={() => setNotificationFilters({ ...notificationFilters, type: 'dispatch' })}>
                  Dispatch <span className="pill-count">{dispatchNotifCount}</span>
                </button>
                <button className={`btn btn-ghost ${notificationFilters.unreadOnly ? 'active' : ''}`} onClick={() => setNotificationFilters({ ...notificationFilters, unreadOnly: !notificationFilters.unreadOnly })}>
                  Solo non lette
                </button>
                <button className="btn btn-ghost" onClick={() => setNotifications([])}>Svuota</button>
              </div>
            </div>
            {filteredNotifications.length === 0 ? (
              <p className="muted">Nessuna notifica recente</p>
            ) : (
              <div className="stack">
                {filteredNotifications.map(item => (
                  <div className={`notif-item ${item.read ? 'read' : ''}`} key={item.id}>
                    <div>
                      <strong>{item.message}</strong>
                      <div className="muted">{item.type}</div>
                      {item.details && <div className="muted notif-details">{item.details}</div>}
                    </div>
                    <div className="muted">{new Date(item.createdAt).toLocaleString('it-IT')}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!token && activeView === 'auth' && (
          <section className="card card-hero" id="section-auth">
              <h2>{authMode === 'login' ? 'Accesso' : 'Registrazione Agenzia'}</h2>
              <form onSubmit={submitAuth} className="stack">
                {authMode === 'register' && (
                  <input placeholder="Nome" value={authForm.name} onChange={e=>setAuthForm({...authForm,name:e.target.value})} />
                )}
                <input placeholder="Email" value={authForm.email} onChange={e=>setAuthForm({...authForm,email:e.target.value})} />
                <input type="password" placeholder="Password" value={authForm.password} onChange={e=>setAuthForm({...authForm,password:e.target.value})} />
                <button type="submit" className="btn btn-primary" disabled={authLoading}>
                  {authLoading ? 'Attendere...' : (authMode === 'login' ? 'Entra' : 'Registrati')}
                </button>
              </form>
              <button className="btn btn-ghost" onClick={()=>setAuthMode(authMode === 'login' ? 'register' : 'login')}>
                {authMode === 'login' ? 'Crea profilo agenzia' : 'Torna all\'accesso'}
              </button>
              <p className="muted">Operatore demo: lucarenna76@gmail.com / operator123</p>
          </section>
        )}

        {!token && activeView === 'recovery' && (
            <section className="card card-hero" id="section-recovery">
              <h3>Recupero password</h3>
              <form onSubmit={submitForgotPassword} className="stack form-block">
                <input
                  placeholder="Email dell'account"
                  value={forgotEmail}
                  onChange={e=>setForgotEmail(e.target.value)}
                />
                <button type="submit" className="btn" disabled={forgotLoading}>
                  {forgotLoading ? 'Invio...' : 'Genera codice reset'}
                </button>
              </form>

              <form onSubmit={submitResetPassword} className="stack form-block">
                <input
                  placeholder="Codice reset"
                  value={resetForm.token}
                  onChange={e=>setResetForm({...resetForm, token: e.target.value})}
                />
                <input
                  type={showResetPassword ? 'text' : 'password'}
                  placeholder="Nuova password"
                  value={resetForm.newPassword}
                  onChange={e=>setResetForm({...resetForm, newPassword: e.target.value})}
                />
                <div className="actions-row">
                  <button type="button" className="btn btn-ghost" onClick={()=>setShowResetPassword(prev=>!prev)}>
                    {showResetPassword ? 'Nascondi password' : 'Mostra password'}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={resetLoading}>
                    {resetLoading ? 'Confermo...' : 'Conferma reset'}
                  </button>
                </div>
              </form>
            </section>
        )}

        {token && (
          <>
            {activeView === 'home' && (
              <section className="card card-hero" id="section-home">
                <div className="top-row">
                  <h2>Panoramica operativa - oggi</h2>
                  <span className="status-pill home-status-pill">Situazione giornata</span>
                  <button className="btn btn-ghost" onClick={() => loadTodayDigest(token, user?.role)} disabled={todayDigestLoading}>
                    {todayDigestLoading ? 'Aggiorno...' : 'Aggiorna'}
                  </button>
                </div>

                <div className="grid kpi-grid">
                  <article className={`kpi-card home-notif-card ${kpi.pending > 0 ? 'home-notif-critical' : ''}`}>
                    <span>Notifiche</span>
                    <strong className={`notif-bell ${kpi.pending > 0 ? 'notif-bell-alert' : ''}`}>🔔 {kpi.pending}</strong>
                  </article>
                  <article className="kpi-card"><span>Arrivi oggi</span><strong>{todayDigestLoading ? <span className="skeleton skeleton-inline" /> : todayDigest.arrivals.length}</strong></article>
                  <article className="kpi-card"><span>Partenze oggi</span><strong>{todayDigestLoading ? <span className="skeleton skeleton-inline" /> : todayDigest.departures.length}</strong></article>
                  <article className="kpi-card"><span>Da validare oggi</span><strong>{todayDigestLoading ? <span className="skeleton skeleton-inline" /> : todayDigest.pendingToday}</strong></article>
                </div>

                {user?.role === 'OPERATOR' && (
                  <div className="actions-row wrap">
                    <button className="btn btn-primary" onClick={goToPendingValidations}>Apri servizi da validare</button>
                    <span className="muted">Nuovi servizi pendenti: {kpi.pending}</span>
                  </div>
                )}

                <div className="grid two-cols">
                  <div className="booking-table dispatch-table">
                    <div className="home-table-title">Arrivi previsti</div>
                    <div className="booking-head dispatch-head-stops">
                      <span>Ora</span>
                      <span>Agenzia</span>
                      <span>Servizio</span>
                      <span>Pax</span>
                      <span>Arrivo</span>
                      <span>Rif.</span>
                    </div>
                    {todayDigest.arrivals.length === 0 ? (
                      <div className="booking-row dispatch-row-stops">
                        <div className="booking-cell muted">-</div><div className="booking-cell muted">Nessun arrivo oggi</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div>
                      </div>
                    ) : todayDigest.arrivals.map(arrival => (
                      <div className="booking-row dispatch-row-stops" key={`arrival-${arrival.id}`}>
                        <div className="booking-cell muted">{arrival.arrivalAt ? new Date(arrival.arrivalAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '-'}</div>
                        <div className="booking-cell">{arrival.agency?.name || '-'}</div>
                        <div className="booking-cell">{arrival.service || '-'}</div>
                        <div className="booking-cell">{arrival.passengers || 0}</div>
                        <div className="booking-cell">{arrival.travelMode || '-'}</div>
                        <div className="booking-cell">{arrival.travelRef || '-'}</div>
                      </div>
                    ))}
                  </div>

                  <div className="booking-table dispatch-table">
                    <div className="home-table-title">Partenze pianificate</div>
                    <div className="booking-head dispatch-head-stops">
                      <span>Ora</span>
                      <span>Agenzia</span>
                      <span>Servizio</span>
                      <span>Mezzo</span>
                      <span>Autista</span>
                      <span>#</span>
                    </div>
                    {todayDigest.departures.length === 0 ? (
                      <div className="booking-row dispatch-row-stops">
                        <div className="booking-cell muted">-</div><div className="booking-cell muted">Nessuna partenza oggi</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div><div className="booking-cell muted">-</div>
                      </div>
                    ) : todayDigest.departures.map(plan => (
                      <div className="booking-row dispatch-row-stops" key={`departure-${plan.id}`}>
                        <div className="booking-cell muted">{plan.scheduledAt ? new Date(plan.scheduledAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '-'}</div>
                        <div className="booking-cell">{plan.booking?.agency?.name || '-'}</div>
                        <div className="booking-cell">{plan.booking?.service || '-'}</div>
                        <div className="booking-cell">{plan.vehicle || '-'}</div>
                        <div className="booking-cell">{plan.driverName || '-'}</div>
                        <div className="booking-cell">#{plan.bookingId}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {activeView === 'profile' && (
            <section className="card card-hero" id="section-profile">
              <div className="top-row">
                <p className="user-line">
                  <strong>{user?.name}</strong> <span className="muted">({user?.role})</span>
                </p>
                <button className="btn btn-danger" onClick={logout}>Esci</button>
              </div>
              <p className="muted">
                Ultimo cambio password: {user?.lastPasswordChangeAt
                  ? new Date(user.lastPasswordChangeAt).toLocaleString('it-IT')
                  : 'non disponibile'}
                {' '}| IP: {user?.lastPasswordChangeIp || 'non disponibile'}
              </p>
            </section>
            )}

            {activeView === 'kpi' && (
            <section className="card" id="section-kpi">
              <div className="top-row">
                <h2>Statistiche</h2>
                <button className="btn" onClick={() => exportKpiTrendCsv(14)}>Export trend 14gg</button>
              </div>
              <div className="grid kpi-grid">
                <article className="kpi-card"><span>Totale</span><strong>{kpiLoading ? <span className="skeleton skeleton-inline" /> : kpi.total}</strong></article>
                <article className="kpi-card"><span>Oggi</span><strong>{kpiLoading ? <span className="skeleton skeleton-inline" /> : kpi.today}</strong></article>
                <article className="kpi-card"><span>In attesa</span><strong>{kpiLoading ? <span className="skeleton skeleton-inline" /> : kpi.pending}</strong></article>
                <article className="kpi-card"><span>Confermate</span><strong>{kpiLoading ? <span className="skeleton skeleton-inline" /> : kpi.confirmed}</strong></article>
                <article className="kpi-card"><span>Rifiutate</span><strong>{kpiLoading ? <span className="skeleton skeleton-inline" /> : kpi.rejected}</strong></article>
              </div>

              <div className="booking-table kpi-trend">
                <div className="home-table-title">Trend ultimi 14 giorni</div>
                <div className="booking-head">
                  <span>Data</span>
                  <span>Totale</span>
                  <span>Confermate</span>
                  <span>In attesa</span>
                  <span>Rifiutate</span>
                  <span>Grafico</span>
                </div>
                {kpiTrendLoading ? (
                  <div className="booking-row">
                    <div className="booking-cell muted">Carico trend...</div>
                  </div>
                ) : kpiTrend.length === 0 ? (
                  <div className="booking-row">
                    <div className="booking-cell muted">Nessun dato disponibile</div>
                  </div>
                ) : (
                  kpiTrend.map(day => {
                    const max = Math.max(day.total, 1)
                    const confirmedPct = Math.round((day.confirmed / max) * 100)
                    const pendingPct = Math.round((day.pending / max) * 100)
                    const rejectedPct = Math.round(((day.rejected || 0) / max) * 100)
                    const pendingStart = Math.min(100, confirmedPct)
                    const rejectedStart = Math.min(100, confirmedPct + pendingPct)
                    return (
                      <div className="booking-row" key={`trend-${day.date}`}>
                        <div className="booking-cell">{day.date}</div>
                        <div className="booking-cell"><strong>{day.total}</strong></div>
                        <div className="booking-cell">{day.confirmed}</div>
                        <div className="booking-cell">{day.pending}</div>
                        <div className="booking-cell">{day.rejected || 0}</div>
                        <div className="booking-cell">
                          <div className="kpi-bar">
                            <span className="kpi-bar-confirmed" style={{ width: `${confirmedPct}%` }} />
                            <span className="kpi-bar-pending" style={{ width: `${pendingPct}%`, left: `${pendingStart}%` }} />
                            <span className="kpi-bar-rejected" style={{ width: `${rejectedPct}%`, left: `${rejectedStart}%` }} />
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>
            )}

            {activeView === 'status' && (
              <section className="card" id="section-status">
                <div className="top-row">
                  <h2>Stato sistema</h2>
                  <button className="btn" onClick={() => {
                    fetch('/api/status').then(r => r.json()).then(data => {
                      setHealth(data)
                      if (data?.schemaReady === false) setSchemaReady(false)
                    })
                  }}>Aggiorna</button>
                </div>
                <div className="grid two-cols">
                  <div className="kpi-card">
                    <span>Schema Ready</span>
                    <strong>{schemaReady ? 'SI' : 'NO'}</strong>
                  </div>
                  <div className="kpi-card">
                    <span>Uptime (s)</span>
                    <strong>{health?.uptimeSeconds ?? '-'}</strong>
                  </div>
                  <div className="kpi-card">
                    <span>Node</span>
                    <strong>{health?.node ?? '-'}</strong>
                  </div>
                  <div className="kpi-card">
                    <span>API</span>
                    <strong>{health?.ok ? 'OK' : 'KO'}</strong>
                  </div>
                </div>
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'operator-tools' && (
              <section className="card card-hero" id="section-operator-tools">
                <h3>Operazioni operatore</h3>
                <div className="actions-row wrap">
                  <button className="btn btn-primary" onClick={showPendingOnly}>Da validare</button>
                  <input type="file" accept=".csv,.pdf" onChange={e=>setImportFile(e.target.files?.[0] || null)} />
                  <label className="chip-toggle">
                    <input
                      type="checkbox"
                      checked={importSkipDuplicates}
                      onChange={e=>setImportSkipDuplicates(e.target.checked)}
                    />
                    Salta duplicati
                  </label>
                  <button className="btn" onClick={previewImportFile} disabled={importPreviewLoading}>
                    {importPreviewLoading ? 'Analizzo...' : 'Anteprima import'}
                  </button>
                  <button className="btn" onClick={importBookingsFile} disabled={importLoading}>
                    {importLoading ? 'Importo...' : 'Importa CSV/PDF'}
                  </button>
                </div>
                {importPreview && (
                  <div className="booking-table">
                    <div className="booking-head">
                      <span>#</span>
                      <span>Agenzia</span>
                      <span>Servizio</span>
                      <span>Pax</span>
                      <span>Arrivo</span>
                      <span>Note</span>
                    </div>
                    {importPreview.previewRows.map(row => (
                      <div key={`preview-${row.row}`} className="booking-row">
                        <div className="booking-cell muted">#{row.row}</div>
                        <div className="booking-cell">{row.agencyEmail || '-'}</div>
                        <div className="booking-cell">{row.service || '-'}</div>
                        <div className="booking-cell">{row.passengers || '-'}</div>
                        <div className="booking-cell muted">{row.arrivalAt || '-'}</div>
                        <div className="booking-cell muted">
                          {row.duplicate ? <span className="tag tag-warning">Duplicato</span> : null}
                          {importPreview.issues.find(issue => issue.row === row.row)?.issues?.join(', ') || (row.duplicate ? '' : 'OK')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {importResult && (
                  <p className="muted">Import: righe {importResult.importedRows}, create {importResult.created}, duplicate {importResult.skipped || 0}, errori {importResult.failed}</p>
                )}
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'dispatch' && (
              <section className="card" id="section-dispatch">
                <div className="top-row">
                  <h2>Pianificazione mezzi</h2>
                  <span className="muted">Drag & drop per ripianificare</span>
                </div>
                <div className="actions-row wrap">
                  <input
                    type="date"
                    value={dispatchFilters.date}
                    onChange={e=>setDispatchFilters({ ...dispatchFilters, date: e.target.value })}
                  />
                  <button className="btn" onClick={applyDispatchFilters}>Filtra per data</button>
                  <button className="btn btn-ghost" onClick={clearDispatchFilters}>Reset filtro</button>
                </div>
                <form className="dispatch-grid" onSubmit={submitDispatchPlan}>
                  <select value={dispatchForm.bookingId} onChange={e=>setDispatchForm({ ...dispatchForm, bookingId: e.target.value })}>
                    <option value="">Prenotazione confermata non pianificata</option>
                    {unplannedBookings.map(b => (
                      <option key={b.id} value={b.id}>
                        #{b.id} - {b.agency?.name || '-'} - {b.service} ({b.passengers} pax)
                      </option>
                    ))}
                  </select>
                  <input
                    type="datetime-local"
                    value={dispatchForm.scheduledAt}
                    onChange={e=>{
                      setDispatchForm({ ...dispatchForm, scheduledAt: e.target.value })
                      setDispatchAvailability({ checked: false, ok: null, message: '' })
                    }}
                  />
                  <select
                    value={dispatchForm.vehicle}
                    onChange={e=>{
                      setDispatchForm({ ...dispatchForm, vehicle: e.target.value })
                      setDispatchAvailability({ checked: false, ok: null, message: '' })
                    }}
                  >
                    <option value="">Seleziona mezzo</option>
                    {vehicles.map(vehicle => (
                      <option key={vehicle.id} value={vehicle.name}>
                        {vehicle.name} ({vehicle.capacity} posti)
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="Autista"
                    value={dispatchForm.driverName}
                    onChange={e=>setDispatchForm({ ...dispatchForm, driverName: e.target.value })}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={checkSingleDispatchAvailability}
                    disabled={dispatchAvailabilityLoading}
                  >
                    {dispatchAvailabilityLoading ? 'Verifico...' : 'Verifica disponibilità'}
                  </button>
                  <input
                    placeholder="Note (opzionale)"
                    value={dispatchForm.notes}
                    onChange={e=>setDispatchForm({ ...dispatchForm, notes: e.target.value })}
                  />
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={dispatchSubmitLoading || (dispatchAvailability.checked && !dispatchAvailability.ok)}
                    title={dispatchAvailability.checked && !dispatchAvailability.ok ? (dispatchAvailability.message || 'Mezzo non disponibile') : ''}
                  >
                    {dispatchSubmitLoading ? 'Pianifico...' : 'Pianifica servizio'}
                  </button>
                </form>
                {dispatchAvailability.checked && (
                  <p className={`availability-line ${dispatchAvailability.ok ? 'availability-ok' : 'availability-ko'}`}>
                    <span aria-hidden="true">{dispatchAvailability.ok ? '✅ ' : '⛔ '}</span>
                    Disponibilità mezzo: {dispatchAvailability.ok ? 'OK' : 'NON DISPONIBILE'}
                    {dispatchAvailability.message ? ` - ${dispatchAvailability.message}` : ''}
                  </p>
                )}

                <div className="top-row dispatch-top-row">
                  <p className="muted">Da pianificare: {unplannedBookings.length}</p>
                  <p className="muted">Piani totali: {dispatchPlans.length}</p>
                </div>

                {dispatchLoading ? (
                  <p className="muted">Caricamento pianificazione...</p>
                ) : dispatchPlans.length === 0 ? (
                  <p className="muted">Nessun servizio pianificato</p>
                ) : (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head dispatch-head">
                      <span>Prenotazione</span>
                      <span>Agenzia</span>
                      <span>Servizio</span>
                      <span>Data/Ora</span>
                      <span>Mezzo</span>
                      <span>Autista</span>
                    </div>
                    {dispatchPlans.map(plan => (
                      <div className="booking-row dispatch-row" key={plan.id}>
                        <div className="booking-cell">#{plan.bookingId}</div>
                        <div className="booking-cell">{plan.booking?.agency?.name || '-'}</div>
                        <div className="booking-cell">{plan.booking?.service || '-'}</div>
                        <div className="booking-cell muted">{plan.scheduledAt ? new Date(plan.scheduledAt).toLocaleString('it-IT') : '-'}</div>
                        <div className="booking-cell">{plan.vehicle}</div>
                        <div className="booking-cell">{plan.driverName}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {user?.role === 'AGENCY' && activeView === 'new-booking' && (
              <section className="card card-hero" id="section-new-booking">
                <h2>Invia prenotazione</h2>
                <form onSubmit={submit} className="actions-row wrap">
                  <select value={form.service} onChange={e=>setForm({...form,service:e.target.value})}>
                    <option value="transfer">Transfer</option>
                    <option value="bus">Bus</option>
                    <option value="ferry">Traghetto</option>
                    <option value="excursion">Escursione</option>
                  </select>
                  <input type="number" min="1" value={form.passengers} onChange={e=>setForm({...form,passengers:Number(e.target.value)})} />
                  <select value={form.hotelId} onChange={e=>setForm({...form, hotelId: e.target.value})}>
                    <option value="">Hotel (opzionale)</option>
                    {hotels.map(hotel => (
                      <option key={hotel.id} value={hotel.id}>{hotel.name}</option>
                    ))}
                  </select>
                  <select value={form.travelMode} onChange={e=>setForm({...form, travelMode: e.target.value})}>
                    <option value="">Arrivo (opzionale)</option>
                    <option value="SHIP">Nave</option>
                    <option value="TRAIN">Treno</option>
                  </select>
                  <input
                    placeholder="Riferimento corsa (es. SNAV 08:20)"
                    value={form.travelRef}
                    onChange={e=>setForm({...form, travelRef: e.target.value})}
                  />
                  <input
                    type="datetime-local"
                    value={form.arrivalAt}
                    onChange={e=>setForm({...form, arrivalAt: e.target.value})}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Importo totale (€) opzionale"
                    value={form.priceTotal}
                    onChange={e=>setForm({...form, priceTotal: e.target.value})}
                  />
                  <button type="submit" className="btn btn-primary" disabled={submitLoading}>
                    {submitLoading ? 'Invio...' : 'Invia'}
                  </button>
                </form>
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'hotels' && (
              <section className="card" id="section-hotels">
                <h2>Hotel e geolocalizzazione</h2>
                <form className="dispatch-grid" onSubmit={submitHotel}>
                  <input placeholder="Nome hotel" value={hotelForm.name} onChange={e=>setHotelForm({ ...hotelForm, name: e.target.value })} />
                  <input placeholder="Indirizzo" value={hotelForm.address} onChange={e=>setHotelForm({ ...hotelForm, address: e.target.value })} />
                  <input placeholder="Latitudine" value={hotelForm.latitude} onChange={e=>setHotelForm({ ...hotelForm, latitude: e.target.value })} />
                  <input placeholder="Longitudine" value={hotelForm.longitude} onChange={e=>setHotelForm({ ...hotelForm, longitude: e.target.value })} />
                  <button type="submit" className="btn btn-primary" disabled={hotelSubmitLoading}>
                    {hotelSubmitLoading ? 'Salvo...' : 'Aggiungi hotel'}
                  </button>
                </form>

                <div className="actions-row wrap">
                  <input
                    type="number"
                    min="1"
                    placeholder="Limite import (opzionale)"
                    value={osmImportForm.limit}
                    onChange={e=>setOsmImportForm({ ...osmImportForm, limit: e.target.value })}
                  />
                  <button className="btn btn-ghost" type="button" onClick={importHotelsFromOsm} disabled={osmImportLoading}>
                    {osmImportLoading ? 'Importo...' : 'Importa strutture ricettive da OSM'}
                  </button>
                </div>
                {osmImportResult && (
                  <p className="muted">
                    OSM: trovati {osmImportResult.found}, creati {osmImportResult.created}, saltati {osmImportResult.skipped}
                  </p>
                )}

                <div className="actions-row wrap">
                  <input type="date" value={stopPlanner.date} onChange={e=>setStopPlanner({ ...stopPlanner, date: e.target.value })} />
                  <input placeholder="Mezzo (opzionale)" value={stopPlanner.vehicle} onChange={e=>setStopPlanner({ ...stopPlanner, vehicle: e.target.value })} />
                  <button className="btn" type="button" onClick={loadOrderedBusStops} disabled={stopPlannerLoading}>
                    {stopPlannerLoading ? 'Ordino...' : 'Ordina fermate bus'}
                  </button>
                </div>

                {orderedBusStops.length > 0 && (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head dispatch-head-stops">
                      <span>#</span>
                      <span>Hotel</span>
                      <span>Distanza km</span>
                      <span>Pax</span>
                      <span>Mezzo</span>
                      <span>Ora servizio</span>
                    </div>
                    {orderedBusStops.map((stop, idx) => (
                      <div className="booking-row dispatch-row-stops" key={`${stop.dispatchId}-${stop.bookingId}`}>
                        <div className="booking-cell">{idx + 1}</div>
                        <div className="booking-cell">{stop.hotel?.name || '-'}</div>
                        <div className="booking-cell">{stop.distanceFromPreviousKm ?? '-'}</div>
                        <div className="booking-cell">{stop.passengers}</div>
                        <div className="booking-cell">{stop.vehicle || '-'}</div>
                        <div className="booking-cell muted">{stop.scheduledAt ? new Date(stop.scheduledAt).toLocaleString('it-IT') : '-'}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="actions-row wrap">
                  <input
                    type="date"
                    value={portShuttleForm.date}
                    onChange={e=>setPortShuttleForm({ ...portShuttleForm, date: e.target.value })}
                  />
                  <select
                    value={portShuttleForm.port}
                    onChange={e=>setPortShuttleForm({ ...portShuttleForm, port: e.target.value })}
                  >
                    {portOptions.map(port => (
                      <option key={port.id} value={port.id}>{port.name}</option>
                    ))}
                  </select>
                  <select
                    value={portShuttleForm.service}
                    onChange={e=>setPortShuttleForm({ ...portShuttleForm, service: e.target.value })}
                  >
                    <option value="transfer">Transfer</option>
                    <option value="bus">Bus</option>
                    <option value="all">Tutti i servizi</option>
                  </select>
                  <button className="btn" type="button" onClick={loadPortShuttle} disabled={portShuttleLoading}>
                    {portShuttleLoading ? 'Ordino...' : 'Navetta porto-hotel'}
                  </button>
                </div>

                {portShuttleStops.length > 0 && (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head dispatch-head-stops">
                      <span>#</span>
                      <span>Hotel</span>
                      <span>Distanza km</span>
                      <span>Pax</span>
                      <span>Arrivo</span>
                      <span>Riferimento</span>
                    </div>
                    {portShuttleStops.map((stop, idx) => (
                      <div className="booking-row dispatch-row-stops" key={`${stop.bookingId}-${stop.hotel?.id || idx}`}>
                        <div className="booking-cell">{idx + 1}</div>
                        <div className="booking-cell">{stop.hotel?.name || '-'}</div>
                        <div className="booking-cell">{stop.distanceFromPreviousKm ?? '-'}</div>
                        <div className="booking-cell">{stop.passengers}</div>
                        <div className="booking-cell muted">
                          {stop.arrivalAt ? new Date(stop.arrivalAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '-'}
                        </div>
                        <div className="booking-cell">{stop.travelRef || '-'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'grouping' && (
              <section className="card" id="section-grouping">
                <h2>Raggruppamento automatico nave/treno</h2>
                <div className="actions-row wrap">
                  <input
                    type="date"
                    value={groupingFilters.date}
                    onChange={e=>setGroupingFilters({ ...groupingFilters, date: e.target.value })}
                  />
                  <select
                    value={groupingFilters.mode}
                    onChange={e=>setGroupingFilters({ ...groupingFilters, mode: e.target.value })}
                  >
                    <option value="SHIP">Nave</option>
                    <option value="TRAIN">Treno</option>
                  </select>
                  <select
                    value={groupingFilters.windowMinutes}
                    onChange={e=>setGroupingFilters({ ...groupingFilters, windowMinutes: Number(e.target.value) })}
                  >
                    <option value={15}>Finestra 15 min</option>
                    <option value={30}>Finestra 30 min</option>
                    <option value={45}>Finestra 45 min</option>
                    <option value={60}>Finestra 60 min</option>
                  </select>
                  <button className="btn" type="button" onClick={loadGroupedArrivals} disabled={groupingLoading}>
                    {groupingLoading ? 'Raggruppo...' : 'Raggruppa arrivi'}
                  </button>
                </div>

                <div className="actions-row wrap">
                  <input
                    type="datetime-local"
                    value={groupDispatchForm.scheduledAt}
                    onChange={e=>{
                      setGroupDispatchForm({ ...groupDispatchForm, scheduledAt: e.target.value })
                      setGroupDispatchAvailability({ checked: false, ok: null, message: '' })
                    }}
                  />
                  <select
                    value={groupDispatchForm.vehicle}
                    onChange={e=>{
                      setGroupDispatchForm({ ...groupDispatchForm, vehicle: e.target.value })
                      setGroupDispatchAvailability({ checked: false, ok: null, message: '' })
                    }}
                  >
                    <option value="">Mezzo per gruppo</option>
                    {vehicles.map(vehicle => (
                      <option key={vehicle.id} value={vehicle.name}>
                        {vehicle.name} ({vehicle.capacity} posti)
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="Autista per gruppo"
                    value={groupDispatchForm.driverName}
                    onChange={e=>setGroupDispatchForm({ ...groupDispatchForm, driverName: e.target.value })}
                  />
                  <button
                    className="btn"
                    type="button"
                    onClick={checkGroupDispatchAvailability}
                    disabled={groupDispatchAvailabilityLoading}
                  >
                    {groupDispatchAvailabilityLoading ? 'Verifico...' : 'Verifica disponibilità'}
                  </button>
                  <input
                    placeholder="Note gruppo (opzionale)"
                    value={groupDispatchForm.notes}
                    onChange={e=>setGroupDispatchForm({ ...groupDispatchForm, notes: e.target.value })}
                  />
                </div>
                {groupDispatchAvailability.checked && (
                  <p className={`availability-line ${groupDispatchAvailability.ok ? 'availability-ok' : 'availability-ko'}`}>
                    <span aria-hidden="true">{groupDispatchAvailability.ok ? '✅ ' : '⛔ '}</span>
                    Disponibilità mezzo gruppo: {groupDispatchAvailability.ok ? 'OK' : 'NON DISPONIBILE'}
                    {groupDispatchAvailability.message ? ` - ${groupDispatchAvailability.message}` : ''}
                  </p>
                )}

                {groupedArrivals.length > 0 && (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head grouped-head">
                      <span>Modo</span>
                      <span>Riferimento</span>
                      <span>Finestra</span>
                      <span>Prenotazioni</span>
                      <span>Totale pax</span>
                      <span>Mezzo suggerito</span>
                      <span>Azione</span>
                    </div>
                    {groupedArrivals.map((group, idx) => (
                      <div className="booking-row grouped-row" key={`${group.mode}-${group.travelRef}-${idx}`}>
                        <div className="booking-cell">{group.mode}</div>
                        <div className="booking-cell">{group.travelRef}</div>
                        <div className="booking-cell muted">
                          {new Date(group.bucketStart).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                          {' - '}
                          {new Date(group.bucketEnd).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="booking-cell">{group.bookingCount}</div>
                        <div className="booking-cell">{group.totalPassengers}</div>
                        <div className="booking-cell"><strong>{group.suggestedVehicle}</strong></div>
                        <div className="booking-cell">
                          <button
                            className="btn btn-primary"
                            type="button"
                            onClick={() => createDispatchFromGroup(group)}
                            disabled={
                              groupDispatchLoadingKey === `${group.mode}-${group.travelRef}-${group.bucketStart}` ||
                              (groupDispatchAvailability.checked && !groupDispatchAvailability.ok)
                            }
                            title={groupDispatchAvailability.checked && !groupDispatchAvailability.ok ? (groupDispatchAvailability.message || 'Mezzo non disponibile') : ''}
                          >
                            {groupDispatchLoadingKey === `${group.mode}-${group.travelRef}-${group.bucketStart}` ? 'Creo...' : 'Crea dispatch gruppo'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'fleet' && (
              <section className="card" id="section-fleet">
                <h2>Flotta disponibile</h2>
                {vehicles.length === 0 ? (
                  <p className="muted">Nessun mezzo disponibile</p>
                ) : (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head fleet-head">
                      <span>Mezzo</span>
                      <span>Tipo</span>
                      <span>Capienza</span>
                      <span>Disponibile</span>
                    </div>
                    {vehicles.map(vehicle => (
                      <div className="booking-row fleet-row" key={vehicle.id}>
                        <div className="booking-cell"><strong>{vehicle.name}</strong></div>
                        <div className="booking-cell">{vehicle.type}</div>
                        <div className="booking-cell">{vehicle.capacity}</div>
                        <div className="booking-cell">{vehicle.isActive ? 'SI' : 'NO'}</div>
                      </div>
                    ))}
                  </div>
                )}

                <h3>Calendario indisponibilità mezzi</h3>
                <form className="dispatch-grid" onSubmit={createVehicleBlock}>
                  <select
                    value={vehicleBlockForm.vehicleId}
                    onChange={e=>setVehicleBlockForm({ ...vehicleBlockForm, vehicleId: e.target.value })}
                  >
                    <option value="">Seleziona mezzo</option>
                    {vehicles.map(vehicle => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {vehicle.name} ({vehicle.capacity} posti)
                      </option>
                    ))}
                  </select>
                  <input
                    type="datetime-local"
                    value={vehicleBlockForm.startAt}
                    onChange={e=>setVehicleBlockForm({ ...vehicleBlockForm, startAt: e.target.value })}
                  />
                  <input
                    type="datetime-local"
                    value={vehicleBlockForm.endAt}
                    onChange={e=>setVehicleBlockForm({ ...vehicleBlockForm, endAt: e.target.value })}
                  />
                  <input
                    placeholder="Motivo (manutenzione, fuori servizio...)"
                    value={vehicleBlockForm.reason}
                    onChange={e=>setVehicleBlockForm({ ...vehicleBlockForm, reason: e.target.value })}
                  />
                  <button type="submit" className="btn btn-primary" disabled={vehicleBlockSubmitLoading}>
                    {vehicleBlockSubmitLoading ? 'Salvo...' : 'Aggiungi indisponibilità'}
                  </button>
                </form>

                {vehicleBlockLoading ? (
                  <p className="muted">Caricamento calendario...</p>
                ) : vehicleBlocks.length === 0 ? (
                  <p className="muted">Nessuna indisponibilità registrata</p>
                ) : (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head fleet-block-head">
                      <span>Mezzo</span>
                      <span>Da</span>
                      <span>A</span>
                      <span>Motivo</span>
                      <span>Azione</span>
                    </div>
                    {vehicleBlocks.map(entry => (
                      <div className="booking-row fleet-block-row" key={entry.id}>
                        <div className="booking-cell"><strong>{entry.vehicle?.name || '-'}</strong></div>
                        <div className="booking-cell muted">{new Date(entry.startAt).toLocaleString('it-IT')}</div>
                        <div className="booking-cell muted">{new Date(entry.endAt).toLocaleString('it-IT')}</div>
                        <div className="booking-cell">{entry.reason || '-'}</div>
                        <div className="booking-cell">
                          <button
                            className="btn btn-danger"
                            type="button"
                            onClick={() => deleteVehicleBlock(entry.id)}
                            disabled={vehicleBlockDeleteId === entry.id}
                          >
                            {vehicleBlockDeleteId === entry.id ? 'Rimuovo...' : 'Rimuovi'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'accounting' && (
              <section className="card" id="section-accounting">
                <div className="top-row">
                  <h2>Contabilità - Estratti conto</h2>
                  <button className="btn btn-primary" onClick={generateWeeklyStatements} disabled={generateStatementsLoading}>
                    {generateStatementsLoading ? 'Genero...' : 'Genera settimanale'}
                  </button>
                </div>

                {statementsLoading ? (
                  <p className="muted">Caricamento estratti conto...</p>
                ) : statements.length === 0 ? (
                  <p className="muted">Nessun estratto conto disponibile</p>
                ) : (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head statement-head">
                      <span>Agenzia</span>
                      <span>Periodo</span>
                      <span>Servizi</span>
                      <span>Passeggeri</span>
                      <span>Totale €</span>
                      <span>Azioni</span>
                    </div>
                    {statements.map(statement => (
                      <div className="booking-row statement-row" key={statement.id}>
                        <div className="booking-cell"><strong>{statement.agency?.name || '-'}</strong></div>
                        <div className="booking-cell muted">
                          {new Date(statement.periodStart).toLocaleDateString('it-IT')} - {new Date(statement.periodEnd).toLocaleDateString('it-IT')}
                        </div>
                        <div className="booking-cell">{statement.bookingsCount}</div>
                        <div className="booking-cell">{statement.passengersSum}</div>
                        <div className="booking-cell"><strong>{Number(statement.grossTotal || 0).toFixed(2)} €</strong></div>
                        <div className="booking-cell actions-row wrap">
                          <button
                            className="btn"
                            onClick={() => exportStatement(statement.id, 'csv')}
                            disabled={statementExportLoadingId === `${statement.id}-csv` || statementExportLoadingId === `${statement.id}-pdf`}
                          >
                            {statementExportLoadingId === `${statement.id}-csv` ? 'Esporto...' : 'CSV'}
                          </button>
                          <button
                            className="btn"
                            onClick={() => exportStatement(statement.id, 'pdf')}
                            disabled={statementExportLoadingId === `${statement.id}-csv` || statementExportLoadingId === `${statement.id}-pdf`}
                          >
                            {statementExportLoadingId === `${statement.id}-pdf` ? 'Esporto...' : 'PDF'}
                          </button>
                          <button
                            className="btn btn-primary"
                            onClick={() => sendStatementEmail(statement.id)}
                            disabled={statementEmailLoadingId === String(statement.id)}
                          >
                            {statementEmailLoadingId === String(statement.id) ? 'Invio...' : 'Email'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {user?.role === 'OPERATOR' && activeView === 'audit' && (
              <section className="card" id="section-audit">
                <div className="top-row">
                  <h2>Audit attività</h2>
                  <button className="btn" onClick={exportAuditCsv}>Export CSV</button>
                </div>
                <div className="filters-grid">
                  <input
                    placeholder="Azione (es. BOOKING_CREATE)"
                    value={auditFilters.action}
                    onChange={e=>setAuditFilters({ ...auditFilters, action: e.target.value })}
                  />
                  <input
                    placeholder="Entità (es. Booking)"
                    value={auditFilters.entityType}
                    onChange={e=>setAuditFilters({ ...auditFilters, entityType: e.target.value })}
                  />
                  <input
                    type="date"
                    value={auditFilters.dateFrom}
                    onChange={e=>setAuditFilters({ ...auditFilters, dateFrom: e.target.value })}
                  />
                  <input
                    type="date"
                    value={auditFilters.dateTo}
                    onChange={e=>setAuditFilters({ ...auditFilters, dateTo: e.target.value })}
                  />
                  <button className="btn" onClick={applyAuditFilters}>Applica filtri</button>
                  <button className="btn btn-ghost" onClick={clearAuditFilters}>Reset filtri</button>
                </div>

                <div className="pagination-row">
                  <button className="btn" onClick={previousAuditPage} disabled={auditPagination.page <= 1}>Precedente</button>
                  <span>Pagina {auditPagination.page} / {auditPagination.totalPages} (Totale: {auditPagination.total})</span>
                  <button className="btn" onClick={nextAuditPage} disabled={auditPagination.page >= auditPagination.totalPages}>Successiva</button>
                </div>

                {auditLoading ? (
                  <p className="muted">Caricamento audit...</p>
                ) : auditLogs.length === 0 ? (
                  <p className="muted">Nessuna attività registrata</p>
                ) : (
                  <div className="booking-table dispatch-table">
                    <div className="booking-head">
                      <span>Data</span>
                      <span>Utente</span>
                      <span>Azione</span>
                      <span>Entità</span>
                      <span>Dettagli</span>
                    </div>
                    {auditLogs.map(entry => (
                      <div className="booking-row" key={entry.id}>
                        <div className="booking-cell muted">{new Date(entry.createdAt).toLocaleString('it-IT')}</div>
                        <div className="booking-cell">{entry.user?.name || '-'}</div>
                        <div className="booking-cell"><strong>{entry.action}</strong></div>
                        <div className="booking-cell">{entry.entityType}{entry.entityId ? ` #${entry.entityId}` : ''}</div>
                        <div className="booking-cell muted">
                          {entry.meta ? JSON.stringify(entry.meta) : '-'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {dispatchPlans.length > 0 && (
                  <div className="dispatch-timeline">
                    <div className="home-table-title">Timeline interattiva ({timelineDate})</div>
                    <div className="timeline-header">
                      <span>Mezzo</span>
                      {timelineSlots.map(slot => (
                        <span key={`slot-${slot}`}>{slot}</span>
                      ))}
                    </div>
                    {vehicles.map(vehicle => {
                      const plans = timelinePlans.filter(plan => plan.vehicle === vehicle.name)
                      const bySlot = plans.reduce((acc, plan) => {
                        const key = getSlotKey(plan.scheduledAt)
                        if (!acc[key]) acc[key] = []
                        acc[key].push(plan)
                        return acc
                      }, {})
                      return (
                        <div className="timeline-row" key={`timeline-${vehicle.name}`}>
                          <div className="timeline-vehicle">
                            <strong>{vehicle.name}</strong>
                            <span className="muted">{vehicle.capacity} posti</span>
                          </div>
                          {timelineSlots.map(slot => {
                            const planList = bySlot[slot] || []
                            const primary = planList[0]
                            const overflow = planList.length - 1
                            return (
                              <div
                                key={`drop-${vehicle.name}-${slot}`}
                                className={`timeline-slot ${primary ? 'occupied' : ''} ${dragHoverSlot.vehicle === vehicle.name && dragHoverSlot.slot === slot ? 'hovered' : ''}`}
                                onDragOver={e=>e.preventDefault()}
                                onDragEnter={() => setDragHoverSlot({ vehicle: vehicle.name, slot })}
                                onDragLeave={() => setDragHoverSlot(prev => prev.vehicle === vehicle.name && prev.slot === slot ? { vehicle: '', slot: '' } : prev)}
                                onDrop={e=>{
                                  e.preventDefault()
                                  const planId = e.dataTransfer.getData('text/plain')
                                  if (!planId) return
                                  setDragHoverSlot({ vehicle: '', slot: '' })
                                  updateDispatchPlan(Number(planId), vehicle.name, `${timelineDate}T${slot}`)
                                }}
                              >
                                {primary && (
                                  <div
                                    className={`timeline-chip ${dispatchUpdateLoadingId === primary.id ? 'loading' : ''}`}
                                    draggable
                                    onDragStart={e=>e.dataTransfer.setData('text/plain', String(primary.id))}
                                    title={`#${primary.bookingId} · ${primary.booking?.agency?.name || '-'} · ${primary.booking?.service || '-'}`}
                                  >
                                    <span>#{primary.bookingId}</span>
                                    <span className="muted">{primary.booking?.service || '-'}</span>
                                  </div>
                                )}
                                {overflow > 0 && (
                                  <span className="timeline-overflow">+{overflow}</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {activeView === 'bookings' && (
            <section className="card" id="section-bookings">
              <div className="top-row">
                <h2>Prenotazioni</h2>
                <button className="btn" onClick={exportBookingsCsv} disabled={exportLoading}>
                  {exportLoading ? 'Esporto...' : 'Esporta CSV'}
                </button>
              </div>

              <div className="filters-grid">
                <select value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}>
                  <option value="">Tutti stati</option>
                  <option value="PENDING">In attesa</option>
                  <option value="CONFIRMED">Confermate</option>
                  <option value="REJECTED">Rifiutate</option>
                </select>
                <select value={filters.service} onChange={e=>setFilters({...filters,service:e.target.value})}>
                  <option value="">Tutti servizi</option>
                  <option value="transfer">Transfer</option>
                  <option value="bus">Bus</option>
                  <option value="ferry">Traghetto</option>
                  <option value="excursion">Escursione</option>
                </select>
                <input type="date" value={filters.dateFrom} onChange={e=>setFilters({...filters,dateFrom:e.target.value})} />
                <input type="date" value={filters.dateTo} onChange={e=>setFilters({...filters,dateTo:e.target.value})} />
                <button className="btn" onClick={applyFilters}>Applica filtri</button>
                <button className="btn btn-ghost" onClick={clearFilters}>Reset filtri</button>
              </div>

              <div className="actions-row wrap">
                <select value={sort.sortBy} onChange={e=>setSort({...sort,sortBy:e.target.value})}>
                  <option value="createdAt">Ordina per Data</option>
                  <option value="service">Ordina per Servizio</option>
                  <option value="status">Ordina per Stato</option>
                  <option value="passengers">Ordina per Passeggeri</option>
                </select>
                <select value={sort.sortDir} onChange={e=>setSort({...sort,sortDir:e.target.value})}>
                  <option value="desc">Discendente</option>
                  <option value="asc">Ascendente</option>
                </select>
                <button className="btn" onClick={applySort}>Applica ordinamento</button>
              </div>

              <div className="pagination-row">
                <button className="btn" onClick={previousPage} disabled={pagination.page <= 1}>Precedente</button>
                <span>Pagina {pagination.page} / {pagination.totalPages} (Totale: {pagination.total})</span>
                <button className="btn" onClick={nextPage} disabled={pagination.page >= pagination.totalPages}>Successiva</button>
                <select value={pagination.pageSize} onChange={e=>changePageSize(e.target.value)}>
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                </select>
              </div>

              {bookingsLoading ? (
                <div className="booking-table">
                  <div className="booking-head">
                    <span>Agenzia</span>
                    <span>Servizio</span>
                    <span>Hotel</span>
                    <span>Pax</span>
                    <span>Creazione</span>
                    <span>Stato</span>
                    <span>Azioni</span>
                  </div>
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <div key={idx} className="booking-row">
                      <span className="skeleton skeleton-line-lg" />
                      <span className="skeleton skeleton-line-md" />
                      <span className="skeleton skeleton-line-sm" />
                      <span className="skeleton skeleton-line-md" />
                      <span className="skeleton skeleton-line-md" />
                      <span className="skeleton skeleton-pill" />
                      <span className="skeleton skeleton-pill" />
                    </div>
                  ))}
                </div>
              ) : bookings.length === 0 ? (
                <div className="empty-state">
                  <strong>Nessuna prenotazione trovata</strong>
                  <p className="muted">Prova a modificare i filtri o crea una nuova prenotazione.</p>
                </div>
              ) : (
                <div className="booking-table">
                  <div className="booking-head">
                    <span>Agenzia</span>
                    <span>Servizio</span>
                    <span>Hotel</span>
                    <span>Pax</span>
                    <span>Creazione</span>
                    <span>Stato</span>
                    <span>Azioni</span>
                  </div>
                  {bookings.map(b=> (
                    <div key={b.id} className={`booking-row ${getStatusUi(b.status).rowClass}`}>
                      <div className="booking-cell booking-cell-main">
                        <strong>{b.agency?.name || '-'}</strong>
                      </div>
                      <div className="booking-cell muted">{b.service}</div>
                      <div className="booking-cell muted">{b.hotel?.name || '-'}</div>
                      <div className="booking-cell">{b.passengers || 0}</div>
                      <div className="booking-cell muted booking-date">{b.createdAt ? new Date(b.createdAt).toLocaleString('it-IT') : '-'}</div>
                      <div className="booking-cell">
                        <span className={`status-pill status-pill-booking ${getStatusUi(b.status).pillClass}`}>
                          <span className="status-icon" aria-hidden="true">{getStatusUi(b.status).icon}</span>
                          {getStatusLabel(b.status)}
                        </span>
                        {b.status === 'REJECTED' && b.rejectionReason && (
                          <div className="muted booking-reason">Motivo: {b.rejectionReason}</div>
                        )}
                      </div>
                      <div className="booking-cell booking-actions">
                        {user?.role === 'OPERATOR' && (
                          <select
                            value={b.hotelId || ''}
                            onChange={e=>assignHotelToBooking(b.id, e.target.value)}
                            disabled={hotelAssignLoadingId === b.id}
                          >
                            <option value="">Hotel</option>
                            {hotels.map(hotel => (
                              <option key={hotel.id} value={hotel.id}>{hotel.name}</option>
                            ))}
                          </select>
                        )}
                        {(user?.role === 'OPERATOR' || user?.role === 'AGENCY') && b.status === 'PENDING' && (
                          <>
                            <button className="btn btn-primary" onClick={()=>approve(b.id)} disabled={approveLoadingId === b.id}>
                              {approveLoadingId === b.id ? 'Approvo...' : 'Approva'}
                            </button>
                            <button className="btn btn-danger" onClick={()=>rejectBooking(b.id)} disabled={rejectLoadingId === b.id}>
                              {rejectLoadingId === b.id ? 'Rifiuto...' : 'Rifiuta'}
                            </button>
                          </>
                        )}
                        {(user?.role === 'OPERATOR' || user?.role === 'AGENCY') && b.status === 'REJECTED' && (
                          <button className="btn btn-ghost" onClick={()=>resetBooking(b.id)} disabled={rejectLoadingId === b.id}>
                            {rejectLoadingId === b.id ? 'Ripristino...' : 'Ripristina'}
                          </button>
                        )}
                        {user?.role === 'OPERATOR' && b.status === 'CONFIRMED' && b.dispatch && (
                          <span className="muted">Pianificata</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            )}
          </>
        )}
        </div>
      </div>
      {toast && (
        <div className="toast-container" role="status" aria-live={toast.type === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
          <div className={`toast toast-${toast.type}`}>
            <span>{toast.message}</span>
            <button type="button" className="toast-close" onClick={() => setToast(null)}>×</button>
          </div>
        </div>
      )}
    </div>
  )
}
