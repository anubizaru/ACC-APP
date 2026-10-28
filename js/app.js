/* =========================================================
 *  app.js — ระบบบัญชีร้านรับจำนำ (Vue 3, no-build)
 * ========================================================= */
(function () {
  'use strict'

  var createApp = Vue.createApp
  var reactive = Vue.reactive
  var ref = Vue.ref
  var computed = Vue.computed

  var chartLoadPromise = null
  function loadChartJs() {
    if (window.Chart) return Promise.resolve(window.Chart)
    if (!chartLoadPromise) {
      chartLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script')
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js'
        script.onload = function () {
          if (window.Chart) resolve(window.Chart)
          else {
            chartLoadPromise = null
            reject(new Error('chart-not-available'))
          }
        }
        script.onerror = function () {
          chartLoadPromise = null
          reject(new Error('chart-load-failed'))
        }
        document.head.appendChild(script)
      })
    }
    return chartLoadPromise
  }

  /* ---------- store กลาง ---------- */

  var store = reactive({
    api: null,          // instance ของ PawnAPI
    mode: null,         // 'demo' | 'real'
    backendProvider: null,
    connectUrl: '',
    token: null,
    user: null,
    data: null,         // bootstrap payload
    loading: false,
    snack: { show: false, text: '', err: false },
    route: { view: 'dashboard', id: null }
  })

  function genId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
  }

  // เก็บค่าถาวรผ่าน cookie (ค่าเล็กน้อย เช่น ลิงก์เชื่อมต่อ/โทเคน) —
  // ใน iframe ที่ถูก sandbox หรือบริบทที่ cookie ถูกปิด ให้ย้อนกลับเป็นหน่วยความจำชั่วคราว (ไม่คงทนข้ามการรีเฟรช)
  var safeStorage = (function () {
    try {
      var enc = encodeURIComponent, dec = decodeURIComponent
      function cget(k) {
        var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + enc(k) + '=([^;]*)'))
        return m ? dec(m[1]) : null
      }
      function cset(k, v) {
        document.cookie = enc(k) + '=' + enc(String(v)) + ';path=/;max-age=31536000;SameSite=Lax'
      }
      function cdel(k) { document.cookie = enc(k) + '=;path=/;max-age=0' }
      cset('pawn-probe', '1')
      var usable = cget('pawn-probe') === '1'
      cdel('pawn-probe')
      if (!usable) return null
      return { getItem: cget, setItem: cset, removeItem: cdel }
    } catch (e) { return null }
  })()
  var memStore = {}
  function lsGet(k) { try { return safeStorage ? safeStorage.getItem(k) : (k in memStore ? memStore[k] : null) } catch (e) { return null } }
  function lsSet(k, v) { try { if (safeStorage) safeStorage.setItem(k, v); else memStore[k] = String(v) } catch (e) { } }
  function lsDel(k) { try { if (safeStorage) safeStorage.removeItem(k); else delete memStore[k] } catch (e) { } }

  function snack(text, err) {
    store.snack.show = true
    store.snack.text = text
    store.snack.err = !!err
    clearTimeout(snack._t)
    snack._t = setTimeout(function () { store.snack.show = false }, 3200)
  }

  async function call(action, data, requestId) {
    if (!store.api) return { ok: false, error: 'no-api' }
    var rid = requestId || genId()
    try {
      var res = await store.api.call(action, data, rid, store.token)
      if (res && res.ok === false && res.error === 'auth') {
        store.user = null
        store.token = null
        store.data = null
        lsDel('pawn_token')
      }
      return res
    } catch (err) {
      snack('เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่', true)
      return { ok: false, error: 'network' }
    }
  }

  async function refresh() {
    store.loading = true
    var res = await call('bootstrap')
    store.loading = false
    if (res && res.ok) {
      store.data = res
      return true
    }
    return false
  }

  function startDemo() {
    store.mode = 'demo'
    store.api = PawnAPI.demo()
    store.backendProvider = null
    store.connectUrl = ''
    store.user = null
    store.token = null
    store.data = null
  }

  async function startReal(url, provider) {
    var api = PawnAPI.real(url)
    var res = await api.call('ping')
    if (!res || res.ok !== true) throw new Error('ping-fail')
    // ping ผ่านไม่ได้แปลว่าพร้อมใช้ — ต้องได้รับเครื่องหมายว่า setup แล้วจาก backend ด้วย
    var st = await api.call('setupStatus')
    if (!st || st.ok !== true || st.setupDone !== true) {
      throw new Error(st && st.ok === true && st.setupDone === false ? 'not-setup' : 'setup-check-failed')
    }
    store.mode = 'real'
    store.api = api
    store.backendProvider = provider || 'apps-script'
    store.connectUrl = url
    lsSet('pawn_url', url)
    lsSet('pawn_provider', store.backendProvider)
    store.user = null
    store.token = null
    store.data = null
  }

  function disconnect() {
    store.api = null
    store.mode = null
    store.backendProvider = null
    store.user = null
    store.token = null
    store.data = null
    lsDel('pawn_url')
    lsDel('pawn_provider')
    lsDel('pawn_token')
    location.hash = ''
  }

  async function doLogin(email, password) {
    var res = await call('login', { email: email, password: password })
    if (res && res.ok) {
      store.token = res.token
      lsSet('pawn_token', res.token)
      // ตั้ง user หลัง bootstrap เสร็จ เพื่อไม่ให้เมนูโผล่ก่อนข้อมูลพร้อม แล้วถูกสลับหน้ากลับ dashboard ทีหลัง
      await refresh()
      if (store.data) {
        store.user = res.user
        if (!location.hash || location.hash === '#/' || location.hash === '#') {
          location.hash = '#/dashboard'
        }
        snack('ยินดีต้อนรับ ' + res.user.name)
        return true
      }
    }
    return false
  }

  function logout() {
    call('logout')
    store.user = null
    store.token = null
    store.data = null
    lsDel('pawn_token')
    location.hash = ''
  }

  /* ---------- router (hash) ---------- */

  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '')
    var parts = h.split('/').filter(Boolean)
    if (parts[0] === 'product' && parts[1]) {
      store.route = { view: 'product', id: parts[1] }
    } else if (['dashboard', 'products', 'accounting', 'creditors', 'reports', 'settings', 'guide'].indexOf(parts[0]) >= 0) {
      store.route = { view: parts[0], id: null }
    } else {
      store.route = { view: 'dashboard', id: null }
    }
  }
  window.addEventListener('hashchange', parseHash)
  parseHash()

  /* ---------- ตัวช่วยแสดงผล ---------- */

  function fmtDate(s) {
    if (!s || s === '0' || s === 0) return '—'
    var p = String(s).slice(0, 10).split('-')
    if (p.length !== 3) return String(s)
    return p[2] + '/' + p[1] + '/' + p[0]
  }
  function fmtMoney(n) { return fmtBaht(n) }
  var TYPE_LABEL = { new: 'รับสินค้าใหม่', interest: 'รับค่าบริการ', redeem: 'ไถ่ถอน', increase: 'เพิ่มต้น', reduce: 'ลดต้น', sale: 'ขายสินค้า' }
  function typeLabel(t) { return TYPE_LABEL[t] || t }
  function customerRiskIndex(products, statements) {
    var productsByCustomer = Object.create(null)
    var statementsByProduct = Object.create(null)
    products.forEach(function (product) {
      var name = String(product.customerName || '').trim().toLowerCase()
      if (!name) return
      if (!productsByCustomer[name]) productsByCustomer[name] = []
      productsByCustomer[name].push(product)
    })
    statements.forEach(function (statement) {
      if (String(statement.void).toLowerCase() === 'true' || statement.voidOf) return
      if (!statementsByProduct[statement.productId]) statementsByProduct[statement.productId] = []
      statementsByProduct[statement.productId].push(statement)
    })

    var index = Object.create(null)
    Object.keys(productsByCustomer).forEach(function (name) {
      var customerProducts = productsByCustomer[name]
      var counts = { renewed: 0, redeemed: 0, overdue: 0, other: 0 }
      customerProducts.forEach(function (product) {
        var productStatements = statementsByProduct[product.id] || []
        productStatements.sort(function (a, b) {
          return String(a.date || '').localeCompare(String(b.date || '')) ||
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        })
        var hasRenewed = false
        var wasOverdue = false
        var previousEndDate = ''
        productStatements.forEach(function (statement) {
          if (statement.type === 'interest') {
            hasRenewed = true
            if (previousEndDate && String(statement.date || '').slice(0, 10) > String(previousEndDate).slice(0, 10)) {
              wasOverdue = true
            }
          }
          if (statement.endDateAfter && statement.endDateAfter !== '0') previousEndDate = statement.endDateAfter
        })

        if (Number(product.status) === 0 && product.closeStatus === 'redeem') {
          counts.redeemed++
        } else if (wasOverdue || (Number(product.status) === 1 && Number(product.due) > 0 && daysLeft(product.endDate) < 0)) {
          counts.overdue++
        } else if (hasRenewed) {
          counts.renewed++
        } else {
          counts.other++
        }
      })

      var groups = [
        { key: 'renewed', label: 'ต่อดอก', color: '#2e7d4f' },
        { key: 'redeemed', label: 'ไถ่ถอน', color: '#2a5f8a' },
        { key: 'overdue', label: 'เกินกำหนด', color: '#a63a3a' },
        { key: 'other', label: 'อื่น ๆ', color: '#a9a493' }
      ]
      var offset = 0
      var stops = []
      groups.forEach(function (group) {
        var end = offset + counts[group.key] / customerProducts.length * 100
        if (end > offset) stops.push(group.color + ' ' + offset + '% ' + end + '%')
        offset = end
        group.count = counts[group.key]
        group.percent = Math.round(counts[group.key] / customerProducts.length * 100)
      })
      index[name] = {
        total: customerProducts.length,
        groups: groups,
        chartStyle: { background: 'conic-gradient(' + stops.join(', ') + ')' }
      }
    })
    return index
  }

  function dueLabel(due) {
    var list = store.data ? store.data.due : []
    for (var i = 0; i < list.length; i++) if (Number(list[i].due) === Number(due)) return list[i].title
    return due === 0 ? 'ขายสินค้า' : due + ' วัน'
  }
  function typeOf(id) {
    var list = store.data ? store.data.types : []
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name
    return '—'
  }
  function daysLeft(endDate) {
    if (!endDate || endDate === '0') return null
    return dateDiffDays(endDate, todayStr())
  }
  function statusBadge(p) {
    if (Number(p.status) === 0) {
      return p.closeStatus === 'sale'
        ? '<span class="badge grey">ขายแล้ว</span>'
        : '<span class="badge blue">ไถ่ถอนแล้ว</span>'
    }
    var d = daysLeft(p.endDate)
    if (d === null) return '<span class="badge gold">รอขาย</span>'
    if (d < 0) return '<span class="badge pink">เกินกำหนด ' + (-d) + ' วัน</span>'
    if (d <= 7) return '<span class="badge amber">เหลือ ' + d + ' วัน</span>'
    return '<span class="badge green">ปกติ</span>'
  }
  function isOverdueCount(p) {
    // จำนวนงวดค้างชำระ (ตามสูตรเดิม)
    return getCountInterest(p.startDate, p.endDate, Number(p.due))
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]
    })
  }

  /* =========================================================
   * คอมโพเนนต์
   * ========================================================= */

  var Snackbar = {
    template: '<div v-if="store.snack.show" class="snackbar" :class="{err: store.snack.err}">{{ store.snack.text }}</div>',
    data: function () { return { store: store } }
  }

  var FlatIcon = {
    props: { name: { type: String, required: true } },
    template: '\
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">\
        <path v-if="name===\'brand\'" d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Zm3 1v2h10v-2H7Zm0 4v1.5h10v-1.5H7Zm0 3.5v1.5h6V14H7Z"/>\
        <path v-else-if="name===\'home\'" d="m2.8 10.3 8.3-7a1.4 1.4 0 0 1 1.8 0l8.3 7a1.4 1.4 0 0 1-1.8 2.1l-.9-.8v8.1h-5.2v-5.4h-3v5.4H5.1v-8.1l-.5.4a1.4 1.4 0 1 1-1.8-2.1Z"/>\
        <path v-else-if="name===\'box\'" d="m12 2.2 9.2 4.7v10.2L12 21.8l-9.2-4.7V6.9L12 2.2Zm0 2.6L6 7.9l6 3.1 6-3.1-6-3.1Zm-7 5.3v5.5l5.8 3v-5.5l-5.8-3Zm8.2 8.5 5.8-3v-5.5l-5.8 3v5.5Z"/>\
        <path v-else-if="name===\'wallet\'" d="M4 4h15a2 2 0 0 1 2 2v1h-4a4 4 0 0 0 0 8h4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm13 5h5v5h-5a2.5 2.5 0 0 1 0-5Zm0 1.7a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6ZM4 2h13v1.5H4A2.5 2.5 0 0 0 1.5 6V7H0V6a4 4 0 0 1 4-4Z"/>\
        <path v-else-if="name===\'users\'" d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7.2-.5a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6ZM9 13c-4.1 0-7 2-7 4.5V21h14v-3.5C16 15 13.1 13 9 13Zm7.2-.3c-.7 0-1.3.1-1.9.2 1.7 1 2.7 2.5 2.7 4.3V21h5v-3.1c0-2.9-2.5-5.2-5.8-5.2Z"/>\
        <path v-else-if="name===\'chart\'" d="M3 3h2v17h17v2H3V3Zm4 11 4-4 3 2 5-6 1.6 1.3-6.2 7.5-3.1-2.1-2.9 2.9L7 14Zm11-8h4v4h-2V9.4l-2-1.6V6Z"/>\
        <path v-else-if="name===\'settings\'" d="m19.4 13.5 1.5 1.2-1.8 3.1-1.8-.7a7.8 7.8 0 0 1-1.8 1l-.3 1.9h-3.6l-.3-1.9a7.8 7.8 0 0 1-1.8-1l-1.8.7-1.8-3.1 1.5-1.2a7 7 0 0 1 0-2.1l-1.5-1.2 1.8-3.1 1.8.7a7.8 7.8 0 0 1 1.8-1l.3-1.9h3.6l.3 1.9a7.8 7.8 0 0 1 1.8 1l1.8-.7 1.8 3.1-1.5 1.2a7 7 0 0 1 0 2.1ZM13.4 9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/>\
        <path v-else-if="name===\'book\'" d="M4 3h15a2 2 0 0 1 2 2v15H6a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2Zm2 2v12a3 3 0 0 1 1-.2h12V5H6Zm2 3h9v1.7H8V8Zm0 3h9v1.7H8V11Z"/>\
        <path v-else-if="name===\'help\'" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 17.8a7.8 7.8 0 1 1 0-15.6 7.8 7.8 0 0 1 0 15.6Zm-.1-13.2c-2.1 0-3.5 1.2-3.7 3.1h2.2c.1-.8.6-1.2 1.5-1.2.8 0 1.3.4 1.3 1.1 0 .6-.3.9-1.2 1.5-1.3.8-1.9 1.6-1.9 3.1v.4h2.2v-.3c0-.9.3-1.3 1.4-2 1.2-.8 1.8-1.6 1.8-2.9 0-1.7-1.4-2.8-3.6-2.8Zm-1.1 9.1v2.2h2.4v-2.2h-2.4Z"/>\
        <path v-else-if="name===\'logout\'" d="M10 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-9v-2h9V5h-9V3ZM3 11h10l-3.5-3.5L11 7l5 5-5 5-1.5-1.5L13 13H3v-2Z"/>\
        <path v-else-if="name===\'eye\'" d="M12 5c-5.2 0-9.2 4.2-10.7 6.2a1.3 1.3 0 0 0 0 1.6C2.8 14.8 6.8 19 12 19s9.2-4.2 10.7-6.2a1.3 1.3 0 0 0 0-1.6C21.2 9.2 17.2 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/>\
        <path v-else-if="name===\'close\'" d="m5.4 4 6.6 6.6L18.6 4 20 5.4 13.4 12l6.6 6.6-1.4 1.4-6.6-6.6L5.4 20 4 18.6 10.6 12 4 5.4 5.4 4Z"/>\
        <path v-else d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2c0-3 3-2.8 3-5a2 2 0 0 0-4 0H8a4 4 0 0 1 8 0c0 3-3 3-3 5Z"/>\
      </svg>'
  }

  var Modal = {
    props: ['title'],
    emits: ['close'],
    template: '\
      <div class="modal-mask" @click.self="$emit(\'close\')" role="dialog" :aria-label="title">\
        <div class="modal">\
          <div class="modal-header"><h3>{{ title }}</h3>\
            <button class="icon-btn" style="background:var(--color-surface-offset);color:var(--color-text)" @click="$emit(\'close\')" aria-label="ปิด"><FlatIcon name="close" /></button>\
          </div>\
          <div class="modal-body"><slot></slot></div>\
        </div>\
      </div>'
  }

  /* ---------- หน้าแรก (เลือกโหมด) ---------- */

  var Welcome = {
    data: function () {
      return { store: store, url: lsGet('pawn_url') || '', provider: lsGet('pawn_provider') || 'apps-script', testing: false, testMsg: '' }
    },
    methods: {
      demo: function () { startDemo() },
      goGuide: function () { startDemo(); location.hash = '#/guide' },
      isCloudflare: function () { return this.provider === 'cloudflare' },
      urlLabel: function () { return this.isCloudflare() ? 'URL ของ Cloudflare Worker' : 'ลิงก์ Web App (จาก Apps Script)' },
      urlPlaceholder: function () { return this.isCloudflare() ? 'https://your-worker.workers.dev' : 'https://script.google.com/macros/s/.../exec' },
      connect: async function () {
        var u = this.url.trim()
        var validUrl = false
        try {
          var parsed = new URL(u)
          validUrl = parsed.protocol === 'https:' && !!parsed.hostname
        } catch (e) {}
        if (!validUrl || (this.provider === 'apps-script' && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(u))) {
          this.testMsg = this.provider === 'cloudflare'
            ? 'กรุณากรอก URL แบบ HTTPS ของ Cloudflare Worker'
            : 'ลิงก์ต้องขึ้นต้นด้วย https://script.google.com/macros/s/ และลงท้ายด้วย /exec'
          return
        }
        this.testing = true
        this.testMsg = ''
        try {
          await startReal(u, this.provider)
          this.testMsg = ''
          snack('เชื่อมต่อสำเร็จ กรุณาเข้าสู่ระบบ')
        } catch (e) {
          var em = e && e.message
          this.testMsg = em === 'not-setup'
            ? this.provider === 'cloudflare'
              ? 'เชื่อมต่อ Worker ได้แล้ว แต่ยังไม่ได้ตั้งค่าผู้ดูแลระบบ ดูขั้นตอนใน cloudflare/README.md'
              : 'เชื่อมต่อได้ แต่ยังไม่ได้รัน setup — เปิด Apps Script แล้วรันฟังก์ชัน setup ก่อน (คู่มือขั้นที่ 4)'
            : em === 'setup-check-failed'
            ? this.provider === 'cloudflare'
              ? 'ตรวจสอบสถานะ D1 ไม่สำเร็จ — ตรวจ schema และการตั้งค่า Worker'
              : 'ตรวจสอบสถานะระบบไม่สำเร็จ — ตรวจว่าวางโค้ดเวอร์ชันล่าสุดและรัน setup แล้ว'
              : this.provider === 'cloudflare'
                ? 'ติดต่อ Worker ไม่ได้ — ตรวจ URL, การ deploy และการตั้งค่า D1'
                : 'ติดต่อไม่ได้ — ตรวจว่า deploy แบบ Web app (Anyone) และรัน setup แล้ว'
        }
        this.testing = false
      }
    },
    template: '\
      <div class="auth-wrap">\
        <div class="auth-card">\
          <div class="hero">\
            <div class="big-mark"><FlatIcon name="brand" /></div>\
            <h1>ระบบบัญชีร้านรับจำนำ</h1>\
            <p>จัดการสินค้า ค่าบริการ บัญชีร้าน เจ้าหนี้ และรายงาน — เชื่อมต่อ Google Sheets หรือ Cloudflare D1</p>\
          </div>\
          <div class="card">\
            <button class="btn block" @click="demo" data-testid="button-demo">เริ่มทดลองใช้งาน (ข้อมูลตัวอย่าง)</button>\
            <p class="muted mt-4" style="font-size:var(--text-xs);text-align:center">โหมดทดลองใช้งานได้ทันที ไม่ต้องตั้งค่า</p>\
          </div>\
          <div class="card mt-4">\
            <div class="card-title">เชื่อมต่อฐานข้อมูล</div>\
            <div class="field"><label for="inp-provider">ผู้ให้บริการฐานข้อมูล</label>\
              <select id="inp-provider" class="input" v-model="provider">\
                <option value="apps-script">Google Sheets (Apps Script)</option>\
                <option value="cloudflare">Cloudflare D1 (Worker)</option>\
              </select>\
            </div>\
            <div class="field"><label for="inp-url">{{ urlLabel() }}</label>\
              <input id="inp-url" class="input" v-model="url" :placeholder="urlPlaceholder()" />\
            </div>\
            <p v-if="isCloudflare()" class="muted mt-4" style="font-size:var(--text-xs)">ต้องตั้งค่า Worker, D1 และผู้ดูแลระบบก่อนเชื่อมต่อ ดูขั้นตอนได้ใน cloudflare/README.md</p>\
            <p v-if="testMsg" class="err" style="font-size:var(--text-xs);color:var(--color-danger);margin-bottom:12px">{{ testMsg }}</p>\
            <button class="btn gold block" @click="connect" :disabled="testing || !url" data-testid="button-connect">{{ testing ? "กำลังตรวจสอบ..." : "เชื่อมต่อ" }}</button>\
            <p class="muted mt-4" style="font-size:var(--text-xs)">ยังไม่มีลิงก์? <button class="linklike" @click="goGuide" style="color:var(--color-gold)">ดูคู่มือตั้งค่า</button> (เปิดในโหมดทดลองก่อนได้)</p>\
          </div>\
        </div>\
      </div>'
  }

  /* ---------- เข้าสู่ระบบ ---------- */

  var Login = {
    data: function () {
      return { store: store, email: '', password: '', busy: false, msg: '' }
    },
    methods: {
      submit: async function () {
        var self = this
        if (!this.email || !this.password) { this.msg = 'กรุณากรอกอีเมลและรหัสผ่าน'; return }
        this.busy = true
        this.msg = ''
        var ok = await doLogin(this.email, this.password)
        this.busy = false
        if (!ok) this.msg = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง (หรือถูกล็อกชั่วคราวจากการพยายามหลายครั้ง)'
      }
    },
    template: '\
      <div class="auth-wrap">\
        <div class="auth-card">\
          <div class="auth-logo">\
            <div class="mark"><FlatIcon name="brand" /></div>\
            <div class="name">ระบบบัญชีร้านรับจำนำ</div>\
          </div>\
          <div class="card">\
            <form @submit.prevent="submit">\
              <div class="field"><label for="inp-email">อีเมล</label>\
                <input id="inp-email" class="input" type="email" v-model="email" autocomplete="username" data-testid="input-email" />\
              </div>\
              <div class="field"><label for="inp-pass">รหัสผ่าน</label>\
                <input id="inp-pass" class="input" type="password" v-model="password" autocomplete="current-password" data-testid="input-password" />\
              </div>\
              <p v-if="msg" style="font-size:var(--text-xs);color:var(--color-danger);margin-bottom:12px">{{ msg }}</p>\
              <button class="btn block" type="submit" :disabled="busy" data-testid="button-login">{{ busy ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ" }}</button>\
            </form>\
          </div>\
          <div v-if="store.mode === \'demo\'" class="card mt-4" style="background:var(--color-warning-soft);border-color:var(--color-warning)">\
            <p style="font-size:var(--text-sm)"><b>บัญชีทดลอง:</b> demo@pawn.test / รหัสผ่าน demo1234</p>\
          </div>\
          <p class="muted mt-4" style="text-align:center;font-size:var(--text-xs)">\
            <button class="btn ghost sm" @click="store.api = null; store.mode = null">← เปลี่ยนการเชื่อมต่อ</button>\
          </p>\
        </div>\
      </div>'
  }

  /* ---------- เปลี่ยนปุ่มตามสิทธิ์ ---------- */

  var Nav = {
    data: function () { return { store: store } },
    computed: {
      view: function () { return store.route.view === 'product' ? 'products' : store.route.view }
    },
    methods: { logout: logout },
    template: '\
      <div>\
        <aside class="sidebar">\
          <div class="brand">\
            <div class="brand-mark"><FlatIcon name="brand" /></div>\
            <div><div class="brand-name">ร้านรับจำนำ</div><div class="brand-sub">{{ store.mode === "demo" ? "โหมดทดลอง" : (store.backendProvider === "cloudflare" ? "Cloudflare D1" : "Google Sheets") }}</div></div>\
          </div>\
          <nav>\
            <a href="#/dashboard" :class="{active: view===\'dashboard\'}"><FlatIcon name="home" />หน้าหลัก</a>\
            <a href="#/products" :class="{active: view===\'products\'}"><FlatIcon name="box" />สินค้า</a>\
            <a href="#/accounting" :class="{active: view===\'accounting\'}"><FlatIcon name="wallet" />บัญชีร้าน</a>\
            <a href="#/creditors" :class="{active: view===\'creditors\'}"><FlatIcon name="users" />เจ้าหนี้</a>\
            <a href="#/reports" :class="{active: view===\'reports\'}"><FlatIcon name="chart" />รายงาน</a>\
            <a href="#/settings" :class="{active: view===\'settings\'}"><FlatIcon name="settings" />ตั้งค่า</a>\
            <a href="#/guide"><FlatIcon name="book" />คู่มือเชื่อมต่อ</a>\
          </nav>\
          <div class="side-foot">\
            <div>{{ store.user ? store.user.name : "" }}</div>\
            <button @click="logout">ออกจากระบบ</button>\
          </div>\
        </aside>\
        <div class="mobile-topbar">\
          <div class="tb-title">ร้านรับจำนำ</div>\
          <div class="tb-actions">\
            <span class="tb-user">{{ store.user ? store.user.name : "" }}</span>\
            <a class="icon-btn" href="#/guide" aria-label="คู่มือ" title="คู่มือ"><FlatIcon name="help" /></a>\
            <button class="icon-btn" @click="logout" aria-label="ออกจากระบบ"><FlatIcon name="logout" /></button>\
          </div>\
        </div>\
        <nav class="bottom-nav">\
          <a href="#/dashboard" :class="{active: view===\'dashboard\'}"><FlatIcon name="home" /><span class="nav-label">หน้าหลัก</span></a>\
          <a href="#/products" :class="{active: view===\'products\'}"><FlatIcon name="box" /><span class="nav-label">สินค้า</span></a>\
          <a href="#/accounting" :class="{active: view===\'accounting\'}"><FlatIcon name="wallet" /><span class="nav-label">บัญชี</span></a>\
          <a href="#/creditors" :class="{active: view===\'creditors\'}"><FlatIcon name="users" /><span class="nav-label">เจ้าหนี้</span></a>\
          <a href="#/reports" :class="{active: view===\'reports\'}"><FlatIcon name="chart" /><span class="nav-label">รายงาน</span></a>\
          <a href="#/settings" :class="{active: view===\'settings\'}"><FlatIcon name="settings" /><span class="nav-label">ตั้งค่า</span></a>\
        </nav>\
      </div>'
  }

  /* ---------- หน้าหลัก ---------- */

  var Dashboard = {
    data: function () { return { store: store, selectedProductId: null } },
    computed: {
      dueSoon: function () {
        if (!store.data) return []
        var out = []
        store.data.products.forEach(function (p) {
          if (Number(p.status) !== 1) return
          var d = daysLeft(p.endDate)
          if (d !== null && d <= 7) out.push({ p: p, d: d })
        })
        out.sort(function (a, b) { return a.d - b.d })
        return out.slice(0, 8)
      },
      activeCount: function () {
        if (!store.data) return 0
        return store.data.products.filter(function (p) { return Number(p.status) === 1 }).length
      },
      principalSummary: function () {
        var summary = { total: 0, overdue: 0, onTime: 0, totalCount: 0, overdueCount: 0, onTimeCount: 0 }
        if (!store.data) return summary
        store.data.products.forEach(function (p) {
          if (Number(p.status) !== 1) return
          var amount = Number(p.price) || 0
          var remainingDays = daysLeft(p.endDate)
          summary.total += amount
          summary.totalCount += 1
          if (remainingDays !== null && remainingDays < 0) {
            summary.overdue += amount
            summary.overdueCount += 1
          } else {
            summary.onTimeCount += 1
          }
        })
        summary.onTime = summary.total - summary.overdue
        return summary
      },
      principalByDue: function () {
        if (!store.data) return []
        var summary = (store.data.due || []).map(function (due) {
          return { id: due.id, due: due.due, title: due.title, amount: 0, count: 0 }
        })
        store.data.products.forEach(function (product) {
          if (Number(product.status) !== 1) return
          var item = null
          for (var i = 0; i < summary.length; i++) {
            if (Number(summary[i].due) === Number(product.due)) {
              item = summary[i]
              break
            }
          }
          if (!item) {
            item = { id: 'due-' + product.due, due: product.due, title: dueLabel(product.due), amount: 0, count: 0 }
            summary.push(item)
          }
          item.amount += Number(product.price) || 0
          item.count += 1
        })
        return summary
      }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney, dueLabel: dueLabel, statusBadge: statusBadge
    },
    mounted: function () { refresh() },
    template: '\
      <div v-if="!store.data" style="display:grid;place-items:center;padding:80px 0"><div class="spinner"></div></div>\
      <div v-else>\
        <h2 class="page-title">หน้าหลัก</h2>\
        <div class="grid grid-4 mb-4">\
          <div class="card stat dashboard-stat"><div class="stat-label">สินค้าในระบบ</div><div class="stat-value">{{ activeCount }}</div><div class="stat-hint">รายการที่ยังเปิดอยู่</div></div>\
          <div class="card stat profit dashboard-stat"><div class="stat-label">เงินต้นสินค้าคงเหลือทั้งหมด</div><div class="stat-value">{{ fmtMoney(principalSummary.total) }} ฿</div><div class="stat-hint">{{ principalSummary.totalCount }} รายการ</div></div>\
          <div class="card stat out dashboard-stat"><div class="stat-label">เงินต้นสินค้าเกินกำหนด</div><div class="stat-value">{{ fmtMoney(principalSummary.overdue) }} ฿</div><div class="stat-hint">{{ principalSummary.overdueCount }} รายการ</div></div>\
          <div class="card stat in dashboard-stat"><div class="stat-label">เงินต้นสินค้าตามกำหนด</div><div class="stat-value">{{ fmtMoney(principalSummary.onTime) }} ฿</div><div class="stat-hint">{{ principalSummary.onTimeCount }} รายการ</div></div>\
        </div>\
        <h3 class="card-title">เงินต้นคงเหลือตามกำหนดชำระ</h3>\
        <div class="grid grid-4 mb-4">\
          <div v-for="item in principalByDue" :key="item.id" class="card stat dashboard-stat">\
            <div class="stat-label">{{ item.title }}</div>\
            <div class="stat-value">{{ fmtMoney(item.amount) }} ฿</div>\
            <div class="stat-hint">{{ item.count }} รายการ</div>\
          </div>\
        </div>\
        <div class="card mt-4">\
          <div class="card-title">ใกล้ครบกำหนด / เกินกำหนด <a href="#/products" style="font-size:var(--text-xs)">ดูทั้งหมด →</a></div>\
          <div v-if="dueSoon.length === 0" class="empty">ไม่มีรายการใกล้ครบกำหนด</div>\
          <div v-for="it in dueSoon" :key="it.p.id" class="list-row clickable" @click="selectedProductId = it.p.id">\
            <div class="prod-no">{{ it.p.productNo }}</div>\
            <div class="grow"><div class="title">{{ it.p.customerName }}</div><div class="sub">{{ it.p.detail }} · {{ dueLabel(it.p.due) }} · ครบกำหนด {{ fmtDate(it.p.endDate) }}</div></div>\
            <span v-html="statusBadge(it.p)"></span>\
          </div>\
        </div>\
        <ProductDetail v-if="selectedProductId" :product-id="selectedProductId" in-modal @close="selectedProductId = null" />\
      </div>'
  }

  /* ---------- ฟอร์มสินค้า (เพิ่ม/แก้ไข) ---------- */

  var ProductForm = {
    props: ['product'],
    emits: ['close', 'saved'],
    data: function () {
      var p = this.product || {}
      var products = store.data ? store.data.products : []
      var nextProductNo = products.reduce(function (max, item) {
        return Math.max(max, Number(item.productNo) || 0)
      }, 0) + 1
      return {
        store: store,
        form: {
          id: p.id || null,
          productNo: p.productNo != null ? p.productNo : nextProductNo,
          customerName: p.customerName || '',
          customerIdCard: p.customerIdCard || '',
          typeId: p.typeId || (store.data && store.data.types[0] ? store.data.types[0].id : ''),
          detail: p.detail || '',
          desc: p.desc || '',
          price: p.price != null ? p.price : '',
          interest: p.interest != null ? p.interest : '',
          due: p.due != null ? p.due : 30,
          startDate: p.startDate || todayStr(),
          endDate: p.endDate && p.endDate !== '0' ? p.endDate : ''
        },
        busy: false,
        applyingHistory: false,
        historySelectedName: '',
        errs: {},
        requestId: genId()
      }
    },
    computed: {
      isEdit: function () { return !!this.product },
      customerHistory: function () {
        var name = this.form.customerName.trim()
        var query = name.toLowerCase()
        if (this.isEdit || !query || name === this.historySelectedName || !store.data) return []
        return store.data.products.filter(function (product) {
          return String(product.customerName || '').toLowerCase().indexOf(query) >= 0
        }).sort(function (a, b) {
          var dateOrder = String(b.startDate || '').localeCompare(String(a.startDate || ''))
          return dateOrder || Number(b.productNo) - Number(a.productNo)
        })
      },
      customerRisk: function () {
        var name = this.form.customerName.trim().toLowerCase()
        if (this.isEdit || !name || !store.data) return null
        return customerRiskIndex(store.data.products, store.data.statements)[name] || null
      },
      endPreview: function () {
        if (this.form.due == 0) return '—'
        return fmtDate(calEndDate(Number(this.form.due), this.form.startDate))
      },
      canEditFinancial: function () {
        if (!this.isEdit || !store.data) return true
        return !store.data.statements.some(function (statement) {
          return statement.productId === this.product.id && statement.type !== 'new'
        }, this)
      }
    },
    watch: {
      'form.customerName': function (name) {
        if (name.trim() !== this.historySelectedName) this.historySelectedName = ''
      },
      'form.price': function (price) {
        if (!this.isEdit && !this.applyingHistory) this.form.interest = price ? calInterest(Number(price)) : ''
      }
    },
    methods: {
      fmtDate: fmtDate,
      fmtMoney: fmtMoney,
      dueLabel: dueLabel,
      typeOf: typeOf,
      num: function (v) { return Number(v) },
      useHistory: function (product) {
        var self = this
        this.applyingHistory = true
        var fields = ['customerIdCard', 'typeId', 'detail', 'desc', 'price', 'interest', 'due']
        for (var i = 0; i < fields.length; i++) {
          var field = fields[i]
          if ((this.form[field] === '' || this.form[field] == null) && product[field] != null && product[field] !== '') {
            this.form[field] = product[field]
          }
        }
        this.form.customerName = product.customerName || this.form.customerName
        this.historySelectedName = this.form.customerName.trim()
        this.$nextTick(function () { self.applyingHistory = false })
      },
      startNewFromHistory: function () {
        if (!this.customerHistory.length) return
        var customer = this.customerHistory[0]
        this.form.customerName = customer.customerName || this.form.customerName
        this.form.customerIdCard = customer.customerIdCard || ''
        this.historySelectedName = this.form.customerName.trim()
      },
      validate: function () {
        var e = {}
        if (!this.form.customerName.trim()) e.customerName = 'กรุณากรอกชื่อลูกค้า'
        if (!this.form.detail.trim()) e.detail = 'กรุณากรอกรายละเอียดสินค้า'
        if (!this.form.typeId) e.typeId = 'เลือกประเภทสินค้า'
        var productNo = Number(this.form.productNo)
        if (!Number.isInteger(productNo) || productNo <= 0) e.productNo = 'เลขที่สินค้าต้องเป็นจำนวนเต็มบวก'
        if (!this.isEdit || this.canEditFinancial) {
          var price = Number(this.form.price)
          if (!price || price <= 0 || !Number.isInteger(price)) e.price = 'ราคาต้องเป็นจำนวนเต็มบาท มากกว่า 0'
          var it = Number(this.form.interest)
          if (isNaN(it) || it < 0 || !Number.isInteger(it)) e.interest = 'ค่าบริการต้องเป็นจำนวนเต็มบาท (0 ได้)'
          var start = dateParse(this.form.startDate)
          if (!start || dateFmt(start) !== this.form.startDate) e.startDate = 'กรุณาระบุวันที่รับให้ถูกต้อง'
          if (Number(this.form.due) !== 0) {
            var end = dateParse(this.form.endDate)
            if (!end || dateFmt(end) !== this.form.endDate) e.endDate = 'กรุณาระบุวันครบกำหนดให้ถูกต้อง'
          }
        }
        this.errs = e
        return Object.keys(e).length === 0
      },
      submit: async function () {
        if (!this.validate()) return
        this.busy = true
        var action = this.isEdit ? 'product.update' : 'product.create'
        var res = await call(action, this.form, this.requestId)
        this.busy = false
        if (res && res.ok) {
          snack(this.isEdit ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มสินค้าเลขที่ ' + res.product.productNo + ' แล้ว')
          await refresh()
          this.$emit('saved', res.product)
          this.$emit('close')
        } else {
          var errorMessages = {
            'invalid-productNo': 'เลขที่สินค้าต้องเป็นจำนวนเต็มบวก',
            'invalid-productNo-taken': 'เลขที่สินค้านี้มีอยู่แล้ว กรุณาใช้เลขอื่น',
            'invalid-price': 'เงินต้นต้องเป็นจำนวนเต็มบาท มากกว่า 0',
            'invalid-interest': 'ค่าบริการต้องเป็นจำนวนเต็มบาท (0 ได้)',
            'invalid-startDate': 'วันที่รับไม่ถูกต้อง',
            'invalid-endDate': 'วันครบกำหนดไม่ถูกต้อง',
            'product-has-history': 'สินค้านี้มีประวัติทำรายการแล้ว จึงแก้เงินและวันที่ไม่ได้'
          }
          var error = res && res.error
          snack('บันทึกไม่สำเร็จ (' + (errorMessages[error] || error || 'ผิดพลาด') + ')', true)
        }
      }
    },
    template: '\
      <Modal :title="isEdit ? \'แก้ไขข้อมูลสินค้า\' : \'รับสินค้าใหม่\'" @close="$emit(\'close\')">\
        <form @submit.prevent="submit">\
          <div class="field"><label for="pf-product-no">เลขที่สินค้า *</label>\
            <input id="pf-product-no" class="input" type="number" min="1" step="1" :class="{invalid: errs.productNo}" v-model.number="form.productNo" data-testid="input-product-no" />\
            <span v-if="errs.productNo" class="err">{{ errs.productNo }}</span>\
          </div>\
          <div class="field"><label for="pf-name">ชื่อลูกค้า *</label>\
            <div class="customer-name-row">\
              <input id="pf-name" class="input" :class="{invalid: errs.customerName}" v-model="form.customerName" data-testid="input-customer" />\
              <div v-if="customerRisk" class="customer-risk" data-testid="customer-history-risk" :aria-label="\'สัดส่วนประวัติลูกค้า \' + customerRisk.total + \' รายการ\'">\
                <div class="customer-risk-chart" :style="customerRisk.chartStyle" role="img" :aria-label="\'สัดส่วนประวัติจาก \' + customerRisk.total + \' รายการ\'"><span>{{ customerRisk.total }}</span></div>\
                <div class="customer-risk-legend">\
                  <span v-for="group in customerRisk.groups" :key="group.key" class="customer-risk-item">\
                    <i :style="{background: group.color}"></i>{{ group.label }} {{ group.percent }}%\
                  </span>\
                </div>\
              </div>\
            </div>\
            <span v-if="customerRisk" class="customer-risk-note">สถิติย้อนหลัง {{ customerRisk.total }} รายการ ไม่ใช่การทำนายแน่นอน</span>\
            <span v-if="errs.customerName" class="err">{{ errs.customerName }}</span>\
            <div v-if="customerHistory.length || (form.customerName.trim() && !isEdit && form.customerName.trim() !== historySelectedName)" class="customer-history" aria-label="ประวัติรายการของลูกค้า">\
              <div class="customer-history-title">ประวัติรายการ ({{ customerHistory.length }})</div>\
              <button v-if="customerHistory.length" type="button" class="customer-history-new" @click="startNewFromHistory">+ เพิ่มรายการใหม่ (ใช้เฉพาะชื่อและเลขบัตรประชาชน)</button>\
              <div v-if="customerHistory.length === 0" class="customer-history-empty">ไม่พบประวัติรายการของชื่อนี้</div>\
              <button v-for="item in customerHistory" :key="item.id" type="button" class="customer-history-item" @click="useHistory(item)" :aria-label="\'เลือกรายการเลขที่ \' + item.productNo + \' \' + item.detail">\
                <span class="customer-history-main"><b>เลขที่ {{ item.productNo }}</b><span>{{ item.detail || \'ไม่ระบุรายละเอียด\' }}</span></span>\
                <span class="customer-history-meta">{{ fmtDate(item.startDate) }} · {{ typeOf(item.typeId) }} · ต้น {{ fmtMoney(item.price) }} ฿ · ค่าบริการ {{ fmtMoney(item.interest) }} ฿ · {{ dueLabel(item.due) }}</span>\
              </button>\
            </div>\
          </div>\
          <div class="field"><label for="pf-card">เลขบัตรประชาชน</label>\
            <input id="pf-card" class="input" v-model="form.customerIdCard" inputmode="numeric" />\
          </div>\
          <div class="field"><label for="pf-type">ประเภทสินค้า *</label>\
            <select id="pf-type" class="input" v-model="form.typeId">\
              <option v-for="t in store.data.types" :key="t.id" :value="t.id">{{ t.name }}</option>\
            </select>\
          </div>\
          <div class="field"><label for="pf-detail">รายละเอียดสินค้า *</label>\
            <input id="pf-detail" class="input" :class="{invalid: errs.detail}" v-model="form.detail" data-testid="input-detail" />\
            <span v-if="errs.detail" class="err">{{ errs.detail }}</span>\
          </div>\
          <template v-if="!isEdit || canEditFinancial">\
            <div class="grid grid-2">\
              <div class="field"><label for="pf-price">ราคา/เงินต้น (บาท) *</label>\
                <input id="pf-price" class="input" type="number" min="1" step="1" :class="{invalid: errs.price}" v-model.number="form.price" data-testid="input-price" />\
                <span v-if="errs.price" class="err">{{ errs.price }}</span>\
              </div>\
              <div class="field"><label for="pf-int">ค่าบริการต่องวด (บาท) *</label>\
                <input id="pf-int" class="input" type="number" min="0" step="1" :class="{invalid: errs.interest}" v-model.number="form.interest" data-testid="input-interest" />\
                <span v-if="errs.interest" class="err">{{ errs.interest }}</span>\
              </div>\
            </div>\
            <div class="grid grid-2">\
              <div class="field"><label for="pf-due">กำหนดชำระ</label>\
                <select id="pf-due" class="input" v-model.number="form.due">\
                  <option v-for="d in store.data.due" :key="d.id" :value="num(d.due)">{{ d.title }}</option>\
                </select>\
              </div>\
              <div class="field"><label for="pf-date">วันที่รับ</label>\
                <input id="pf-date" class="input" type="date" :class="{invalid: errs.startDate}" v-model="form.startDate" data-testid="input-start-date" />\
                <span v-if="errs.startDate" class="err">{{ errs.startDate }}</span>\
              </div>\
            </div>\
            <div v-if="isEdit" class="field"><label for="pf-end-date">วันครบกำหนด</label>\
              <input id="pf-end-date" class="input" type="date" :class="{invalid: errs.endDate}" v-model="form.endDate" :disabled="Number(form.due) === 0" data-testid="input-end-date" />\
              <span v-if="errs.endDate" class="err">{{ errs.endDate }}</span>\
              <span v-else-if="Number(form.due) === 0" class="hint">สินค้านี้ไม่มีวันครบกำหนด</span>\
            </div>\
            <p v-else class="hint" style="margin-bottom:16px">วันครบกำหนด: <b>{{ endPreview }}</b></p>\
          </template>\
          <div v-if="isEdit && !canEditFinancial" class="hint" style="margin-bottom:16px">สินค้านี้มีประวัติทำรายการแล้ว ระบบล็อกเงินต้น ค่าบริการ และวันที่เพื่อรักษาความถูกต้องของประวัติและการกลับรายการ</div>\
          <div class="field"><label for="pf-desc">หมายเหตุ</label>\
            <textarea id="pf-desc" class="input" rows="2" v-model="form.desc"></textarea>\
          </div>\
          <div class="modal-actions">\
            <button type="button" class="btn ghost" @click="$emit(\'close\')">ยกเลิก</button>\
            <button type="submit" class="btn" :disabled="busy" data-testid="button-save-product">{{ busy ? "กำลังบันทึก..." : "บันทึก" }}</button>\
          </div>\
        </form>\
      </Modal>'
  }

  /* ---------- สินค้า (รายการ) ---------- */

  var ProductRecordDialog = {
    props: ['product', 'statements'],
    computed: {
      latestInterestStatement: function () {
        var statements = this.statements.filter(function (statement) {
          return statement.type === 'interest' && !statement.void && !statement.voidOf
        })
        statements.sort(function (a, b) {
          return String(a.createdAt || a.date || '').localeCompare(String(b.createdAt || b.date || ''))
        })
        return statements.length ? statements[statements.length - 1] : null
      }
    },
    methods: {
      fmtDate: fmtDate,
      fmtMoney: fmtMoney,
      remainingDays: function (endDate) { return daysLeft(endDate) },
      remainingDaysClass: function (endDate) {
        var days = daysLeft(endDate)
        if (days < 0) return 'overdue'
        return days <= 7 ? 'warning' : 'normal'
      }
    },
    template: '\
      <Modal :title="\'รายละเอียดรายการ · สินค้าเลขที่ \' + product.productNo" @close="$emit(\'close\')">\
        <div class="payment-receipt" data-testid="product-record-details">\
          <div class="payment-receipt-heading">รายละเอียดรายการสินค้า</div>\
          <div class="payment-receipt-product">สินค้าเลขที่ {{ product.productNo }}</div>\
          <div class="payment-receipt-details">\
            <div class="payment-receipt-row"><span>ชื่อลูกค้า</span><b>{{ product.customerName }}</b></div>\
            <div class="payment-receipt-row"><span>รายการสินค้า</span><b>{{ product.detail }}</b></div>\
            <div class="payment-receipt-row"><span>เงินต้น</span><b>{{ fmtMoney(product.price) }} ฿</b></div>\
            <div class="payment-receipt-row"><span>ค่าบริการต่องวด</span><b>{{ fmtMoney(product.interest) }} ฿</b></div>\
            <div v-if="latestInterestStatement" class="payment-receipt-row payment-receipt-paid"><span>รับค่าบริการล่าสุด</span><b>{{ fmtMoney(latestInterestStatement.profit) }} ฿</b></div>\
            <div v-if="latestInterestStatement" class="payment-receipt-row"><span>วันที่รับค่าบริการล่าสุด</span><b>{{ fmtDate(latestInterestStatement.date) }}</b></div>\
            <div class="payment-receipt-row payment-receipt-due"><span>ครบกำหนดครั้งถัดไป</span><b>{{ Number(product.due) === 0 ? \'ไม่มีวันครบกำหนด\' : (product.endDate && product.endDate !== \'0\' ? fmtDate(product.endDate) : \'—\') }}</b></div>\
            <div v-if="Number(product.due) !== 0 && product.endDate && product.endDate !== \'0\'" class="payment-receipt-row payment-receipt-due payment-receipt-countdown" :class="remainingDaysClass(product.endDate)"><span>{{ remainingDays(product.endDate) < 0 ? \'เกินกำหนด\' : \'จำนวนวันคงเหลือ\' }}</span><b>{{ Math.abs(remainingDays(product.endDate)) }} วัน</b></div>\
          </div>\
          <p v-if="product.desc" class="payment-receipt-note">หมายเหตุ: {{ product.desc }}</p>\
          <div class="modal-actions"><button type="button" class="btn" @click="$emit(\'close\')">ปิด</button></div>\
        </div>\
      </Modal>'
  }

  var Products = {
    data: function () {
      return { store: store, q: '', filter: 'active', dueFilter: 'all', sortBy: 'productNo', sortDirection: 'desc', showForm: false, editProduct: null, recordProduct: null, detailProductId: null }
    },
    computed: {
      customerRisks: function () {
        if (!store.data) return Object.create(null)
        return customerRiskIndex(store.data.products, store.data.statements)
      },
      list: function () {
        if (!store.data) return []
        var self = this
        var q = this.q.trim().toLowerCase()
        var out = store.data.products.filter(function (p) {
          if (self.filter === 'active' && Number(p.status) !== 1) return false
          if (self.filter === 'closed' && Number(p.status) !== 0) return false
          if (self.filter === 'overdue') {
            var remainingDays = daysLeft(p.endDate)
            if (Number(p.status) !== 1 || remainingDays === null || remainingDays >= 0) return false
          }
          if (self.dueFilter !== 'all' && Number(p.due) !== Number(self.dueFilter)) return false
          if (!q) return true
          var hay = (p.customerName + ' ' + p.detail + ' ' + p.productNo + ' ' + (p.customerIdCard || '')).toLowerCase()
          return hay.indexOf(q) >= 0
        })
        out.sort(function (a, b) {
          if (self.sortBy === 'due') {
            var aDate = a.endDate && a.endDate !== '0' ? String(a.endDate).slice(0, 10) : ''
            var bDate = b.endDate && b.endDate !== '0' ? String(b.endDate).slice(0, 10) : ''
            if (!aDate && bDate) return 1
            if (aDate && !bDate) return -1
            var dateOrder = aDate.localeCompare(bDate)
            return self.sortDirection === 'asc' ? dateOrder : -dateOrder
          }
          var productNoOrder = Number(a.productNo) - Number(b.productNo)
          return self.sortDirection === 'asc' ? productNoOrder : -productNoOrder
        })
        return out
      }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney, dueLabel: dueLabel, statusBadge: statusBadge,
      customerRiskFor: function (product) {
        var name = String(product.customerName || '').trim().toLowerCase()
        return this.customerRisks[name] || null
      },
      statementsFor: function (product) {
        if (!store.data) return []
        return store.data.statements.filter(function (statement) { return statement.productId === product.id })
      },
      toggleSort: function (field) {
        if (this.sortBy !== field) {
          this.sortBy = field
          this.sortDirection = field === 'due' ? 'asc' : 'desc'
        } else {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc'
        }
      }
    },
    setup: function () {
      // เก็บ self สำหรับ computed ที่อ้าง filter ผ่าน closure
    },
    template: '\
      <div>\
        <div class="row spread">\
          <div><h2 class="page-title" style="margin-bottom:8px">สินค้า</h2></div>\
          <button class="btn" @click="showForm = true; editProduct = null" data-testid="button-add-product">+ รับสินค้าใหม่</button>\
        </div>\
        <div class="row mb-4">\
          <input class="input" style="max-width:320px" v-model="q" placeholder="ค้นหา: ชื่อลูกค้า รายละเอียด เลขรายการ" aria-label="ค้นหาสินค้า" data-testid="input-search" />\
          <select class="input" style="max-width:200px" v-model="dueFilter" aria-label="กรองตามกำหนดชำระ" data-testid="filter-due">\
            <option value="all">ทุกกำหนดชำระ</option>\
            <option v-for="d in store.data.due" :key="d.id" :value="String(d.due)">{{ d.title }}</option>\
          </select>\
          <div class="chip-row">\
            <button class="chip" :class="{active: filter===\'active\'}" @click="filter=\'active\'">อยู่ในระบบ</button>\
            <button class="chip" :class="{active: filter===\'overdue\'}" @click="filter=\'overdue\'">เกินกำหนด</button>\
            <button class="chip" :class="{active: filter===\'closed\'}" @click="filter=\'closed\'">ปิดแล้ว</button>\
            <button class="chip" :class="{active: filter===\'all\'}" @click="filter=\'all\'">ทั้งหมด</button>\
          </div>\
          <button class="btn ghost sm" @click="toggleSort(\'due\')" :aria-pressed="sortBy === \'due\'" data-testid="button-sort-due">{{ sortBy === \'due\' ? (sortDirection === \'asc\' ? \'วันครบกำหนด ↑\' : \'วันครบกำหนด ↓\') : \'เรียงตามวันครบกำหนด\' }}</button>\
          <button class="btn ghost sm" @click="toggleSort(\'productNo\')" :aria-pressed="sortBy === \'productNo\'" data-testid="button-sort-product-no">{{ sortBy === \'productNo\' ? (sortDirection === \'asc\' ? \'เลขที่สินค้า ↑\' : \'เลขที่สินค้า ↓\') : \'เรียงตามเลขที่สินค้า\' }}</button>\
        </div>\
        <div class="card">\
          <div v-if="list.length === 0" class="empty">\
            <FlatIcon name="box" />\
            ไม่พบสินค้า\
          </div>\
          <div v-for="p in list" :key="p.id" class="list-row clickable product-list-row" @click="detailProductId = p.id" :data-testid="\'card-product-\' + p.id">\
            <div class="prod-no">{{ p.productNo }}</div>\
            <div class="grow">\
              <div class="title">{{ p.customerName }}</div>\
              <div class="sub">{{ p.detail }} · {{ dueLabel(p.due) }} · ครบกำหนด {{ p.endDate && p.endDate !== \'0\' ? fmtDate(p.endDate) : \'—\' }}</div>\
              <div class="sub">ต้น {{ fmtMoney(p.price) }} ฿ · ค่าบริการ {{ fmtMoney(p.interest) }} ฿ · รับ {{ fmtDate(p.startDate) }}</div>\
            </div>\
            <div v-if="customerRiskFor(p)" class="product-customer-risk" :data-testid="\'customer-risk-product-\' + p.id" :aria-label="\'สัดส่วนประวัติลูกค้า \' + customerRiskFor(p).total + \' รายการ\'">\
              <div class="customer-risk-chart product-customer-risk-chart" :style="customerRiskFor(p).chartStyle" role="img" :aria-label="\'สัดส่วนประวัติจาก \' + customerRiskFor(p).total + \' รายการ\'"><span>{{ customerRiskFor(p).total }}</span></div>\
              <div class="customer-risk-legend">\
                <span v-for="group in customerRiskFor(p).groups" :key="group.key" class="customer-risk-item">\
                  <i :style="{background: group.color}"></i>{{ group.label }} {{ group.percent }}%\
                </span>\
              </div>\
            </div>\
            <span class="product-status" v-html="statusBadge(p)"></span>\
            <button class="btn ghost sm product-record-action" @click.stop="recordProduct = p" :aria-label="\'ดูรายละเอียดรายการสินค้าเลขที่ \' + p.productNo" title="ดูรายละเอียดรายการ" :data-testid="\'button-record-details-\' + p.id"><FlatIcon name="eye" /></button>\
          </div>\
        </div>\
        <ProductForm v-if="showForm" :product="editProduct" @close="showForm = false" @saved="editProduct = null" />\
        <ProductRecordDialog v-if="recordProduct" :product="recordProduct" :statements="statementsFor(recordProduct)" @close="recordProduct = null" />\
        <ProductDetail v-if="detailProductId" :product-id="detailProductId" in-modal @close="detailProductId = null" />\
      </div>'
  }

  /* ---------- กล่องโต้ตอบรายการการเงิน ---------- */

  var FinanceDialog = {
    props: ['product', 'op'],
    emits: ['close', 'done'],
    data: function () {
      var p = this.product
      var overdue = getCountInterest(p.startDate, p.endDate, Number(p.due))
      var defAmount = 0
      if (this.op === 'interest') defAmount = Number(p.interest)
      if (this.op === 'redeem') defAmount = overdue * Number(p.interest) + Number(p.interest)
      return {
        store: store,
        amount: defAmount,
        note: '',
        busy: false,
        receipt: null,
        requestId: genId()
      }
    },
    computed: {
      titleMap: function () {
        return { interest: 'รับค่าบริการ', redeem: 'ไถ่ถอน (คืนสินค้า)', increase: 'เพิ่มต้น', reduce: 'ลดต้น', sale: 'ขายสินค้า' }
      },
      title: function () { return this.titleMap[this.op] || this.op },
      canSubmit: function () {
        if (this.busy) return false
        var a = Number(this.amount)
        if (isNaN(a) || a < 0) return false
        // ดอกเบี้ย/ไถ่ถอน อาจเป็น 0 ได้ (สินค้าดอก 0 บาท), รายการอื่นต้องมากกว่า 0
        var zeroOk = this.op === 'interest' || this.op === 'redeem'
        if (!zeroOk && !(a > 0)) return false
        return true
      },
      preview: function () {
        var p = this.product
        var a = Number(this.amount) || 0
        var out = {
          cashIn: 0, cashOut: 0,
          priceAfter: Number(p.price), interestAfter: Number(p.interest),
          endDateAfter: p.endDate, statusAfter: Number(p.status), closeAfter: ''
        }
        if (this.op === 'interest') {
          out.cashIn = a
          out.endDateAfter = calEndDate(Number(p.due), p.endDate)
        } else if (this.op === 'redeem') {
          out.cashIn = Number(p.price) + a
          out.statusAfter = 0
          out.closeAfter = 'ไถ่ถอนแล้ว'
        } else if (this.op === 'increase') {
          out.cashOut = a
          out.priceAfter = Number(p.price) + a
          out.interestAfter = calInterest(Number(p.price) + a)
          out.endDateAfter = calEndDate(Number(p.due), p.endDate)
        } else if (this.op === 'reduce') {
          out.cashIn = a
          out.priceAfter = Math.max(0, Number(p.price) - a)
          out.interestAfter = calInterest(Math.max(0, Number(p.price) - a))
        } else if (this.op === 'sale') {
          out.cashIn = a
          out.statusAfter = 0
          out.closeAfter = 'ขายแล้ว'
        }
        return out
      }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney,
      inAmt: function (a) { return Number(a.income) > 0 ? '+' + fmtMoney(a.income) : '—' },
      payAmt: function (a) { return Number(a.pay) > 0 ? fmtMoney(a.pay) : '—' },
      submit: async function () {
        this.busy = true
        var res = await call('finance.op', {
          id: this.product.id, op: this.op, amount: Number(this.amount), note: this.note
        }, this.requestId)
        this.busy = false
        if (res && res.ok) {
          if (this.op !== 'interest') snack('บันทึกรายการสินค้าเลขที่ ' + this.product.productNo + ' สำเร็จ')
          await refresh()
          this.$emit('done')
          if (this.op === 'interest') {
            this.receipt = { product: res.product, statement: res.statement }
          } else {
            this.$emit('close')
          }
        } else {
          var msg = { 'product-closed': 'สินค้ารายการนี้ปิดไปแล้ว', 'invalid-amount': 'จำนวนเงินไม่ถูกต้อง' }
          snack('ทำรายการไม่สำเร็จ: ' + (msg[res && res.error] || (res && res.error) || 'ผิดพลาด'), true)
        }
      }
    },
    template: '\
      <Modal :title="receipt ? \'รับค่าบริการสำเร็จ\' : title + \' · สินค้าเลขที่ \' + product.productNo" @close="$emit(\'close\')">\
        <div v-if="receipt" class="payment-receipt" data-testid="interest-receipt">\
          <div class="payment-receipt-heading">ยืนยันการรับค่าบริการ</div>\
          <div class="payment-receipt-product">สินค้าเลขที่ {{ receipt.product.productNo }}</div>\
          <div class="payment-receipt-details">\
            <div class="payment-receipt-row"><span>ชื่อลูกค้า</span><b>{{ receipt.product.customerName }}</b></div>\
            <div class="payment-receipt-row"><span>รายการสินค้า</span><b>{{ receipt.product.detail }}</b></div>\
            <div class="payment-receipt-row"><span>เงินต้น</span><b>{{ fmtMoney(receipt.product.price) }} ฿</b></div>\
            <div class="payment-receipt-row"><span>ค่าบริการต่องวด</span><b>{{ fmtMoney(receipt.product.interest) }} ฿</b></div>\
            <div class="payment-receipt-row"><span>วันที่ทำรายการ</span><b>{{ fmtDate(receipt.statement.date) }}</b></div>\
            <div class="payment-receipt-row payment-receipt-due"><span>ครบกำหนดครั้งถัดไป</span><b>{{ Number(receipt.product.due) === 0 ? \'ไม่มีวันครบกำหนด\' : (receipt.statement.endDateAfter && receipt.statement.endDateAfter !== \'0\' ? fmtDate(receipt.statement.endDateAfter) : \'—\') }}</b></div>\
          </div>\
          <p v-if="receipt.statement.note" class="payment-receipt-note">หมายเหตุ: {{ receipt.statement.note }}</p>\
          <div class="modal-actions"><button type="button" class="btn" @click="$emit(\'close\')">ปิด</button></div>\
        </div>\
        <form v-else @submit.prevent="submit">\
          <div class="confirm-box">\
            <div class="row"><span class="lbl">ลูกค้า / สินค้า</span><span class="val">{{ product.customerName }} · {{ product.detail }}</span></div>\
            <div class="row"><span class="lbl">เงินต้นปัจจุบัน</span><span class="val">{{ fmtMoney(product.price) }} ฿</span></div>\
            <div class="row"><span class="lbl">ค่าบริการต่องวด</span><span class="val">{{ fmtMoney(product.interest) }} ฿</span></div>\
            <div class="row"><span class="lbl">วันครบกำหนดปัจจุบัน</span><span class="val">{{ product.endDate && product.endDate !== \'0\' ? fmtDate(product.endDate) : \'—\' }}</span></div>\
          </div>\
          <div class="field"><label for="fin-amount">{{ op === \'interest\' ? \'ค่าบริการที่รับ (บาท)\' : op === \'redeem\' ? \'ค่าบริการค้างชำระรวมงวดนี้ (บาท)\' : op === \'sale\' ? \'ราคาที่ขายได้ (บาท)\' : \'จำนวนเงิน (บาท)\' }}</label>\
            <input id="fin-amount" class="input" type="number" min="0" step="1" v-model.number="amount" data-testid="input-amount" />\
          </div>\
          <div class="field"><label for="fin-note">หมายเหตุ</label><input id="fin-note" class="input" v-model="note" /></div>\
          <div class="confirm-box">\
            <div class="row"><span class="lbl">เงินรับเข้า</span><span class="val pos">{{ fmtMoney(preview.cashIn) }} ฿</span></div>\
            <div class="row"><span class="lbl">เงินจ่ายออก</span><span class="val neg">{{ fmtMoney(preview.cashOut) }} ฿</span></div>\
            <div class="row" v-if="op === \'increase\' || op === \'reduce\'"><span class="lbl">เงินต้นหลังทำรายการ</span><span class="val">{{ fmtMoney(preview.priceAfter) }} ฿</span></div>\
            <div class="row" v-if="op === \'increase\' || op === \'reduce\'"><span class="lbl">ค่าบริการใหม่ต่องวด</span><span class="val">{{ fmtMoney(preview.interestAfter) }} ฿</span></div>\
            <div class="row" v-if="op === \'interest\' || op === \'increase\'"><span class="lbl">วันครบกำหนดใหม่</span><span class="val">{{ preview.endDateAfter && preview.endDateAfter !== \'0\' ? fmtDate(preview.endDateAfter) : \'—\' }}</span></div>\
            <div class="row" v-if="op === \'redeem\' || op === \'sale\'"><span class="lbl">สถานะหลังทำรายการ</span><span class="val">{{ preview.closeAfter }}</span></div>\
          </div>\
          <div class="modal-actions">\
            <button type="button" class="btn ghost" @click="$emit(\'close\')">ยกเลิก</button>\
            <button type="submit" class="btn" :disabled="!canSubmit" data-testid="button-confirm-finance">{{ busy ? "กำลังบันทึก..." : "ยืนยันทำรายการ" }}</button>\
          </div>\
        </form>\
      </Modal>'
  }

  /* ---------- รายละเอียดสินค้า ---------- */

  var ProductDetail = {
    props: {
      productId: { type: String, default: '' },
      inModal: { type: Boolean, default: false }
    },
    emits: ['close'],
    data: function () {
      return { store: store, op: null, showEditForm: false, voidTarget: null, busy: false, voidRequestId: genId() }
    },
    computed: {
      p: function () {
        var id = this.productId || store.route.id
        if (!store.data) return null
        var out = null
        store.data.products.forEach(function (x) { if (x.id === id) out = x })
        return out
      },
      statements: function () {
        if (!store.data || !this.p) return []
        var pid = this.p.id
        var out = store.data.statements.filter(function (s) { return s.productId === pid })
        out.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1 })
        return out
      },
      isAdmin: function () { return store.user && store.user.role === 'admin' }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney, dueLabel: dueLabel, statusBadge: statusBadge, typeLabel: typeLabel, typeOf: typeOf,
      active: function () { return this.p && Number(this.p.status) === 1 },
      dueCountdown: function (product) {
        if (Number(product.status) !== 1) return ''
        var days = daysLeft(product.endDate)
        if (days === null) return ''
        return days < 0 ? 'เกินกำหนด ' + (-days) + ' วัน' : 'เหลือ ' + days + ' วัน'
      },
      isOverdue: function (product) {
        var days = daysLeft(product.endDate)
        return Number(product.status) === 1 && days !== null && days < 0
      },
      cashIn: function (s) {
        var v = Number(s.income) + Number(s.profit)
        return v > 0 ? '+' + fmtMoney(v) : '—'
      },
      payOf: function (s) { return Number(s.pay) > 0 ? fmtMoney(s.pay) : '—' },
      idCardFmt: function (id) {
        id = String(id || '')
        if (!id || id.length < 13) return id || '—'
        return id.slice(0, 1) + '-' + id.slice(1, 5) + '-' + id.slice(5, 10) + '-' + id.slice(10, 12) + '-' + id.slice(12)
      },
      cashInOf: cashInOf,
      doVoid: async function () {
        var self = this
        this.busy = true
        var res = await call('statement.void', { id: this.voidTarget.id }, this.voidRequestId + '-' + this.voidTarget.id)
        this.busy = false
        if (res && res.ok) {
          snack('กลับรายการเรียบร้อย')
          await refresh()
        } else {
          snack('กลับรายการไม่สำเร็จ (' + ((res && res.error) || '') + ')', true)
        }
        this.voidTarget = null
      }
    },
    template: '\
      <div v-if="p" :class="inModal ? \'modal-mask product-detail-mask\' : \'\'" @click.self="inModal && $emit(\'close\')">\
        <div :class="inModal ? \'modal product-detail-dialog\' : \'\'" :role="inModal ? \'dialog\' : null" :aria-modal="inModal ? \'true\' : null" :aria-label="inModal ? \'รายละเอียดสินค้าเลขที่ \' + p.productNo : null">\
        <div :class="inModal ? \'product-detail-header\' : \'\'">\
          <button v-if="!inModal" class="btn ghost sm mb-4" @click="$go(\'products\')">← กลับรายการสินค้า</button>\
          <div class="row spread">\
            <h2 class="page-title" style="margin:0">สินค้าเลขที่ {{ p.productNo }} <span v-html="statusBadge(p)"></span></h2>\
            <button v-if="inModal" class="icon-btn" style="background:var(--color-surface-offset);color:var(--color-text)" @click="$emit(\'close\')" aria-label="ปิด">✕</button>\
          </div>\
          <p class="page-sub" style="margin-top:8px">{{ typeOf(p.typeId) }} · {{ dueLabel(p.due) }}</p>\
        </div>\
        <div :class="inModal ? \'product-detail-body\' : \'\'">\
        <div class="card">\
          <div class="grid grid-2">\
            <div><div class="muted" style="font-size:var(--text-xs)">ลูกค้า</div><b>{{ p.customerName }}</b></div>\
            <div><div class="muted" style="font-size:var(--text-xs)">บัตรประชาชน</div>{{ idCardFmt(p.customerIdCard) }}</div>\
            <div><div class="muted" style="font-size:var(--text-xs)">รายละเอียด</div><b>{{ p.detail }}</b></div>\
            <div><div class="muted" style="font-size:var(--text-xs)">หมายเหตุ</div>{{ p.desc || \'—\' }}</div>\
            <div><div class="muted" style="font-size:var(--text-xs)">เงินต้น</div><b>{{ fmtMoney(p.price) }} ฿</b></div>\
            <div><div class="muted" style="font-size:var(--text-xs)">ค่าบริการต่องวด</div><b>{{ fmtMoney(p.interest) }} ฿</b></div>\
            <div><div class="muted" style="font-size:var(--text-xs)">วันที่รับ</div>{{ fmtDate(p.startDate) }}</div>\
            <div><div class="muted" style="font-size:var(--text-xs)">วันครบกำหนด</div>{{ p.endDate && p.endDate !== \'0\' ? fmtDate(p.endDate) : \'—\' }}<div v-if="dueCountdown(p)" style="margin-top:4px"><span :class="isOverdue(p) ? \'badge pink\' : \'muted\'" style="font-size:var(--text-xs)">{{ dueCountdown(p) }}</span></div></div>\
          </div>\
        </div>\
        <div class="card">\
          <div v-if="active()" class="card-title">ทำรายการ</div>\
          <div class="grid grid-3">\
            <button v-if="active()" class="btn gold" @click="op=\'interest\'" data-testid="button-op-interest">รับค่าบริการ</button>\
            <button v-if="active()" class="btn" @click="op=\'redeem\'" data-testid="button-op-redeem">ไถ่ถอน</button>\
            <button v-if="active()" class="btn outline" @click="op=\'increase\'" data-testid="button-op-increase">เพิ่มต้น</button>\
            <button v-if="active()" class="btn outline" @click="op=\'reduce\'" data-testid="button-op-reduce">ลดต้น</button>\
            <button v-if="active()" class="btn danger" @click="op=\'sale\'" data-testid="button-op-sale">ขายสินค้า</button>\
            <button class="btn outline" @click="showEditForm = true" data-testid="button-edit-product">แก้ไข</button>\
          </div>\
        </div>\
        <div class="card">\
          <div class="card-title">ประวัติรายการ</div>\
          <div class="tbl-wrap">\
            <table class="tbl">\
              <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">รับเข้า</th><th class="num">จ่ายออก</th><th class="num">กำไร</th><th></th></tr></thead>\
              <tbody>\
                <tr v-for="s in statements" :key="s.id">\
                  <td>{{ fmtDate(s.date) }}</td>\
                  <td>{{ typeLabel(s.type) }}<span v-if="s.void" class="badge pink" style="margin-left:6px">ยกเลิก</span></td>\
                  <td class="num">{{ cashIn(s) }}</td>\
                  <td class="num">{{ payOf(s) }}</td>\
                  <td class="num">{{ fmtMoney(s.profit) }}</td>\
                  <td class="right">\
                    <button v-if="isAdmin && !s.void && s.type !== \'new\'" class="btn ghost sm" @click="voidTarget = s">กลับรายการ</button>\
                  </td>\
                </tr>\
              </tbody>\
            </table>\
          </div>\
        </div>\
        </div>\
        <FinanceDialog v-if="op" :product="p" :op="op" @close="op = null" />\
        <ProductForm v-if="showEditForm" :product="p" @close="showEditForm = false" />\
        <Modal v-if="voidTarget" title="ยืนยันกลับรายการ" @close="voidTarget = null">\
          <p style="font-size:var(--text-sm)">จะกลับรายการ "{{ typeLabel(voidTarget.type) }}" วันที่ {{ fmtDate(voidTarget.date) }} และคืนสถานะสินค้าก่อนรายการนั้นหรือไม่</p>\
          <div class="modal-actions">\
            <button class="btn ghost" @click="voidTarget = null">ยกเลิก</button>\
            <button class="btn danger" :disabled="busy" @click="doVoid">กลับรายการ</button>\
          </div>\
        </Modal>\
        </div>\
      </div>\
      <div v-else class="empty">ไม่พบสินค้านี้ <a href="#/products">กลับรายการสินค้า</a></div>'
  }

  /* ---------- บัญชีร้าน ---------- */

  var Accounting = {
    data: function () {
      return {
        store: store,
        form: { date: todayStr(), title: '', side: 'out', amount: '' },
        show: false,
        busy: false,
        requestId: genId()
      }
    },
    computed: {
      list: function () {
        if (!store.data) return []
        var out = store.data.accounting.slice()
        out.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)) })
        return out
      },
      isAdmin: function () { return store.user && store.user.role === 'admin' }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney,
      inAmt: function (a) { return Number(a.income) > 0 ? '+' + fmtMoney(a.income) : '—' },
      payAmt: function (a) { return Number(a.pay) > 0 ? fmtMoney(a.pay) : '—' },
      submit: async function () {
        var self = this
        if (!this.form.title.trim() || !(Number(this.form.amount) > 0)) { snack('กรอกชื่อรายการและจำนวนเงินให้ครบ', true); return }
        this.busy = true
        var data = {
          date: this.form.date,
          title: this.form.title,
          income: this.form.side === 'in' ? Number(this.form.amount) : 0,
          pay: this.form.side === 'out' ? Number(this.form.amount) : 0
        }
        var res = await call('accounting.add', data, this.requestId)
        this.busy = false
        if (res && res.ok) {
          snack('บันทึกบัญชีร้านแล้ว')
          this.form.title = ''
          this.form.amount = ''
          this.show = false
          await refresh()
        } else {
          snack('บันทึกไม่สำเร็จ (' + ((res && res.error) || '') + ')', true)
        }
      },
      doVoid: async function (a) {
        var res = await call('accounting.void', { id: a.id }, genId())
        if (res && res.ok) { snack('กลับรายการเรียบร้อย'); await refresh() }
        else snack('กลับรายการไม่สำเร็จ (' + ((res && res.error) || '') + ')', true)
      }
    },
    template: '\
      <div>\
        <div class="row spread">\
          <h2 class="page-title" style="margin-bottom:8px">บัญชีร้าน</h2>\
          <button class="btn" @click="show = true" data-testid="button-add-accounting">+ บันทึกรายรับ/จ่าย</button>\
        </div>\
        <p class="page-sub">รายรับ-รายจ่ายของร้านที่ไม่เกี่ยวกับสินค้า (ค่าไฟ ค่าเช่า ฯลฯ)</p>\
        <div class="card">\
          <div v-if="list.length === 0" class="empty">ยังไม่มีรายการ</div>\
          <div class="tbl-wrap">\
            <table class="tbl">\
              <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">รายรับ</th><th class="num">รายจ่าย</th><th></th></tr></thead>\
              <tbody>\
                <tr v-for="a in list" :key="a.id">\
                  <td>{{ fmtDate(a.date) }}</td>\
                  <td>{{ a.title }}<span v-if="a.void" class="badge pink" style="margin-left:6px">ยกเลิก</span></td>\
                  <td class="num" style="color:var(--color-success)">{{ inAmt(a) }}</td>\
                  <td class="num" style="color:var(--color-danger)">{{ payAmt(a) }}</td>\
                  <td class="right"><button v-if="isAdmin && !a.void" class="btn ghost sm" @click="doVoid(a)">กลับรายการ</button></td>\
                </tr>\
              </tbody>\
            </table>\
          </div>\
        </div>\
        <Modal v-if="show" title="บันทึกบัญชีร้าน" @close="show = false">\
          <form @submit.prevent="submit">\
            <div class="field"><label for="ac-date">วันที่</label><input id="ac-date" class="input" type="date" v-model="form.date" /></div>\
            <div class="field"><label for="ac-title">ชื่อรายการ</label><input id="ac-title" class="input" v-model="form.title" placeholder="เช่น ค่าไฟฟ้า" data-testid="input-ac-title" /></div>\
            <div class="field"><label>ประเภท</label>\
              <div class="chip-row">\
                <button type="button" class="chip" :class="{active: form.side===\'out\'}" @click="form.side=\'out\'">รายจ่าย</button>\
                <button type="button" class="chip" :class="{active: form.side===\'in\'}" @click="form.side=\'in\'">รายรับ</button>\
              </div>\
            </div>\
            <div class="field"><label for="ac-amount">จำนวนเงิน (บาท)</label><input id="ac-amount" class="input" type="number" min="1" step="1" v-model.number="form.amount" data-testid="input-ac-amount" /></div>\
            <div class="modal-actions">\
              <button type="button" class="btn ghost" @click="show = false">ยกเลิก</button>\
              <button type="submit" class="btn" :disabled="busy">บันทึก</button>\
            </div>\
          </form>\
        </Modal>\
      </div>'
  }

  /* ---------- เจ้าหนี้ ---------- */

  var Creditors = {
    data: function () {
      return {
        store: store,
        showCred: false,
        moveFor: null,
        moveForm: { date: todayStr(), side: 'borrow', amount: '', note: '' },
        credForm: { name: '', note: '' },
        busy: false
      }
    },
    computed: {
      list: function () {
        if (!store.data) return []
        var moves = store.data.creditorMoves
        return store.data.creditors.map(function (c) {
          var bal = 0
          moves.forEach(function (m) {
            if (m.creditorId === c.id) bal += Number(m.borrow) - Number(m.refund)
          })
          var latest = ''
          moves.forEach(function (m) { if (m.creditorId === c.id && m.date > latest) latest = m.date })
          return { c: c, bal: bal, latest: latest }
        })
      }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney,
      saveCred: async function () {
        if (!this.credForm.name.trim()) { snack('กรอกชื่อเจ้าหนี้', true); return }
        this.busy = true
        var res = await call('creditor.save', this.credForm, genId())
        this.busy = false
        if (res && res.ok) {
          snack('บันทึกเจ้าหนี้แล้ว')
          this.showCred = false
          this.credForm = { name: '', note: '' }
          await refresh()
        } else snack('บันทึกไม่สำเร็จ', true)
      },
      saveMove: async function () {
        var amt = Number(this.moveForm.amount)
        if (!(amt > 0)) { snack('กรอกจำนวนเงิน', true); return }
        this.busy = true
        var res = await call('creditorMove.add', {
          creditorId: this.moveFor.c.id,
          date: this.moveForm.date,
          borrow: this.moveForm.side === 'borrow' ? amt : 0,
          refund: this.moveForm.side === 'refund' ? amt : 0,
          note: this.moveForm.note
        }, genId())
        this.busy = false
        if (res && res.ok) {
          snack('บันทึกรายการเจ้าหนี้แล้ว')
          this.moveFor = null
          await refresh()
        } else snack('บันทึกไม่สำเร็จ', true)
      }
    },
    template: '\
      <div>\
        <div class="row spread">\
          <h2 class="page-title" style="margin-bottom:8px">เจ้าหนี้</h2>\
          <button class="btn" @click="showCred = true" data-testid="button-add-creditor">+ เพิ่มเจ้าหนี้</button>\
        </div>\
        <p class="page-sub">ยอดคงเหลือ = ยืมมา − คืนไปแล้ว</p>\
        <div class="card">\
          <div v-if="list.length === 0" class="empty">ยังไม่มีเจ้าหนี้</div>\
          <div v-for="it in list" :key="it.c.id" class="list-row">\
            <div class="grow">\
              <div class="title">{{ it.c.name }}</div>\
              <div class="sub">ล่าสุด {{ it.latest ? fmtDate(it.latest) : \'—\' }}</div>\
            </div>\
            <div class="right"><b style="font-size:var(--text-base)">{{ fmtMoney(it.bal) }} ฿</b><div class="muted" style="font-size:var(--text-xs)">คงค้าง</div></div>\
            <button class="btn sm" @click="moveFor = it; moveForm = { date: todayStr(), side: \'refund\', amount: \'\', note: \'\' }" :data-testid="\'button-move-\' + it.c.id">บันทึกชำระ</button>\
          </div>\
        </div>\
        <Modal v-if="showCred" title="เพิ่มเจ้าหนี้" @close="showCred = false">\
          <form @submit.prevent="saveCred">\
            <div class="field"><label for="cr-name">ชื่อ</label><input id="cr-name" class="input" v-model="credForm.name" /></div>\
            <div class="field"><label for="cr-note">หมายเหตุ</label><input id="cr-note" class="input" v-model="credForm.note" /></div>\
            <div class="modal-actions">\
              <button type="button" class="btn ghost" @click="showCred = false">ยกเลิก</button>\
              <button type="submit" class="btn" :disabled="busy">บันทึก</button>\
            </div>\
          </form>\
        </Modal>\
        <Modal v-if="moveFor" :title="\'รายการเจ้าหนี้: \' + moveFor.c.name" @close="moveFor = null">\
          <form @submit.prevent="saveMove">\
            <div class="field"><label for="mv-date">วันที่</label><input id="mv-date" class="input" type="date" v-model="moveForm.date" /></div>\
            <div class="field"><label>ประเภท</label>\
              <div class="chip-row">\
                <button type="button" class="chip" :class="{active: moveForm.side===\'refund\'}" @click="moveForm.side=\'refund\'">คืนเงิน</button>\
                <button type="button" class="chip" :class="{active: moveForm.side===\'borrow\'}" @click="moveForm.side=\'borrow\'">ยืมเพิ่ม</button>\
              </div>\
            </div>\
            <div class="field"><label for="mv-amount">จำนวนเงิน (บาท)</label><input id="mv-amount" class="input" type="number" min="1" step="1" v-model.number="moveForm.amount" /></div>\
            <div class="field"><label for="mv-note">หมายเหตุ</label><input id="mv-note" class="input" v-model="moveForm.note" /></div>\
            <div class="modal-actions">\
              <button type="button" class="btn ghost" @click="moveFor = null">ยกเลิก</button>\
              <button type="submit" class="btn" :disabled="busy">บันทึก</button>\
            </div>\
          </form>\
        </Modal>\
      </div>'
  }

  /* ---------- รายงาน ---------- */

  var Reports = {
    data: function () {
      var now = new Date()
      var p = function (n) { return String(n).padStart(2, '0') }
      var start = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-01'
      return {
        store: store,
        start: start,
        end: todayStr(),
        result: null,
        busy: false,
        chart: null
      }
    },
    methods: {
      fmtDate: fmtDate, fmtMoney: fmtMoney, typeLabel: typeLabel,
      cashIn: function (s) {
        var v = Number(s.income) + Number(s.profit)
        return v > 0 ? '+' + fmtMoney(v) : '—'
      },
      payOf: function (s) { return Number(s.pay) > 0 ? fmtMoney(s.pay) : '—' },
      inAmt: function (a) { return Number(a.income) > 0 ? fmtMoney(a.income) : '—' },
      payAmt: function (a) { return Number(a.pay) > 0 ? fmtMoney(a.pay) : '—' },
      run: async function () {
        var self = this
        this.busy = true
        var res = await call('report.range', { start: this.start, end: this.end })
        this.busy = false
        if (res && res.ok) {
          this.result = res
          this.$nextTick(function () { self.drawChart() })
        } else {
          snack('ดึงรายงานไม่สำเร็จ', true)
        }
      },
      drawChart: async function () {
        var el = this.$refs.canvas
        if (!el || !this.result) return
        var ChartLib
        try {
          ChartLib = await loadChartJs()
        } catch (err) {
          snack('โหลดกราฟไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต', true)
          return
        }
        if (!el.isConnected || this.$refs.canvas !== el) return
        if (this.chart) this.chart.destroy()
        // รวมรายรับ/จ่ายต่อวัน (สินค้า + บัญชีร้าน)
        var byDay = {}
        function add(day, inn, out) {
          if (!byDay[day]) byDay[day] = { in: 0, out: 0 }
          byDay[day].in += inn
          byDay[day].out += out
        }
        this.result.statements.forEach(function (s) {
          add(s.date, Number(s.income) + Number(s.profit), Number(s.pay))
        })
        this.result.accounting.forEach(function (a) {
          add(a.date, Number(a.income), Number(a.pay))
        })
        var days = Object.keys(byDay).sort()
        var inData = days.map(function (d) { return byDay[d].in })
        var outData = days.map(function (d) { return -byDay[d].out })
        this.chart = new ChartLib(el, {
          type: 'bar',
          data: {
            labels: days.map(function (d) { return d.slice(8) + '/' + d.slice(5, 7) }),
            datasets: [
              { label: 'รับเข้า', data: inData, backgroundColor: '#2e7d4f', borderRadius: 3 },
              { label: 'จ่ายออก', data: outData, backgroundColor: '#a63a3a', borderRadius: 3 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: false } },
            plugins: { legend: { labels: { font: { family: 'Anuphan' } } } }
          }
        })
      },
      exportCsv: function () {
        if (!this.result) return
        var rows = [['วันที่', 'ประเภท', 'เลขรายการ', 'ลูกค้า', 'รายละเอียด', 'รับเข้า', 'จ่ายออก', 'กำไร']]
        var self = this
        this.result.statements.forEach(function (s) {
          rows.push([s.date, typeLabel(s.type), s.productNo, s.customerName, s.detail, Number(s.income) + Number(s.profit), Number(s.pay), Number(s.profit)])
        })
        this.result.accounting.forEach(function (a) {
          rows.push([a.date, 'บัญชีร้าน: ' + a.title, '', '', '', Number(a.income), Number(a.pay), 0])
        })
        var csv = '\uFEFF' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"' }).join(',') }).join('\r\n')
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        var a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'report-' + this.start + '_' + this.end + '.csv'
        a.click()
        URL.revokeObjectURL(a.href)
      }
    },
    mounted: function () { this.run() },
    beforeUnmount: function () {
      if (this.chart) {
        this.chart.destroy()
        this.chart = null
      }
    },
    template: '\
      <div>\
        <h2 class="page-title">รายงาน</h2>\
        <div class="card mb-4">\
          <div class="row">\
            <div class="field" style="margin:0"><label for="rp-start">จากวันที่</label><input id="rp-start" class="input" type="date" v-model="start" /></div>\
            <div class="field" style="margin:0"><label for="rp-end">ถึงวันที่</label><input id="rp-end" class="input" type="date" v-model="end" /></div>\
            <button class="btn" @click="run" :disabled="busy" data-testid="button-run-report">{{ busy ? "กำลังดึงข้อมูล..." : "ดูรายงาน" }}</button>\
            <button class="btn outline" @click="exportCsv" v-if="result">ส่งออก CSV</button>\
          </div>\
        </div>\
        <div v-if="result">\
          <div class="grid grid-3">\
            <div class="card stat in"><div class="stat-label">รับเข้ารวม (สินค้า)</div><div class="stat-value">{{ fmtMoney(result.summary.cashIn) }} ฿</div></div>\
            <div class="card stat out"><div class="stat-label">จ่ายออกรวม (สินค้า)</div><div class="stat-value">{{ fmtMoney(result.summary.cashOut) }} ฿</div></div>\
            <div class="card stat profit"><div class="stat-label">กำไร/ค่าบริการ</div><div class="stat-value">{{ fmtMoney(result.summary.profit) }} ฿</div></div>\
          </div>\
          <div class="card mt-4">\
            <div class="card-title">กราฟรายรับ-จ่ายรายวัน (รวมบัญชีร้าน)</div>\
            <div class="chart-box"><canvas ref="canvas"></canvas></div>\
          </div>\
          <div class="card mt-4">\
            <div class="card-title">รายการสินค้า ({{ result.statements.length }} รายการ)</div>\
            <div class="tbl-wrap">\
              <table class="tbl">\
                <thead><tr><th>วันที่</th><th>รายการ</th><th>เลข</th><th>ลูกค้า</th><th class="num">รับเข้า</th><th class="num">จ่ายออก</th><th class="num">กำไร</th></tr></thead>\
                <tbody>\
                  <tr v-for="s in result.statements" :key="s.id">\
                    <td>{{ fmtDate(s.date) }}</td><td>{{ typeLabel(s.type) }}</td><td>{{ s.productNo }}</td><td>{{ s.customerName }}</td>\
                    <td class="num">{{ cashIn(s) }}</td>\
                    <td class="num">{{ payOf(s) }}</td>\
                    <td class="num">{{ fmtMoney(s.profit) }}</td>\
                  </tr>\
                </tbody>\
              </table>\
            </div>\
          </div>\
          <div class="card mt-4">\
            <div class="card-title">บัญชีร้าน ({{ result.accounting.length }} รายการ)</div>\
            <div class="tbl-wrap">\
              <table class="tbl">\
                <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">รายรับ</th><th class="num">รายจ่าย</th></tr></thead>\
                <tbody>\
                  <tr v-for="a in result.accounting" :key="a.id">\
                    <td>{{ fmtDate(a.date) }}</td><td>{{ a.title }}</td>\
                    <td class="num">{{ inAmt(a) }}</td>\
                    <td class="num">{{ payAmt(a) }}</td>\
                  </tr>\
                </tbody>\
              </table>\
            </div>\
          </div>\
        </div>\
      </div>'
  }

  /* ---------- ตั้งค่า ---------- */

  var Settings = {
    data: function () {
      return {
        store: store,
        tab: 'types',
        typeForm: { name: '' },
        dueForm: { due: 30, unit: 'day', title: '', color: 'green' },
        userForm: { name: '', email: '', password: '', role: 'staff' },
        passForm: { current: '', next: '' },
        busy: false
      }
    },
    computed: {
      isAdmin: function () { return store.user && store.user.role === 'admin' },
      users: function () { return this.isAdmin && store.data ? store.data.employees : [] }
    },
    methods: {
      fmtDate: fmtDate,
      active: function (u) { return Number(u.active) === 1 },
      saveType: async function () {
        if (!this.typeForm.name.trim()) return
        var res = await call('type.save', this.typeForm, genId())
        if (res && res.ok) { snack('บันทึกประเภทสินค้าแล้ว'); this.typeForm = { name: '' }; await refresh() }
        else snack('บันทึกไม่สำเร็จ', true)
      },
      saveDue: async function () {
        if (!this.dueForm.title.trim()) return
        var res = await call('due.save', this.dueForm, genId())
        if (res && res.ok) { snack('บันทึกกำหนดชำระแล้ว'); await refresh() }
        else snack('บันทึกไม่สำเร็จ', true)
      },
      saveUser: async function () {
        if (!this.userForm.name || !this.userForm.email || this.userForm.password.length < 6) {
          snack('กรอกข้อมูลผู้ใช้ให้ครบ (รหัสผ่านอย่างน้อย 6 ตัว)', true); return
        }
        var res = await call('user.save', this.userForm, genId())
        if (res && res.ok) {
          snack('เพิ่มผู้ใช้แล้ว')
          this.userForm = { name: '', email: '', password: '', role: 'staff' }
          await refresh()
        } else {
          var m = { 'duplicate-email': 'อีเมลนี้มีในระบบแล้ว', 'weak-password': 'รหัสผ่านสั้นเกินไป' }
          snack(m[res && res.error] || 'บันทึกไม่สำเร็จ', true)
        }
      },
      toggleUser: async function (u) {
        var res = await call('user.save', { id: u.id, name: u.name, email: u.email, role: u.role, active: Number(u.active) === 1 ? 0 : 1 }, genId())
        if (res && res.ok) { snack('อัปเดตผู้ใช้แล้ว'); await refresh() }
        else snack('อัปเดตไม่สำเร็จ (' + ((res && res.error) || '') + ')', true)
      },
      changePass: async function () {
        if (this.passForm.next.length < 6) { snack('รหัสผ่านใหม่ต้องอย่างน้อย 6 ตัว', true); return }
        var res = await call('user.password', { currentPassword: this.passForm.current, newPassword: this.passForm.next }, genId())
        if (res && res.ok) { snack('เปลี่ยนรหัสผ่านแล้ว'); this.passForm = { current: '', next: '' } }
        else snack('เปลี่ยนไม่สำเร็จ — ตรวจรหัสผ่านเดิม', true)
      },
      disconnect: function () { disconnect() }
    },
    template: '\
      <div>\
        <h2 class="page-title">ตั้งค่า</h2>\
        <div class="chip-row mb-4">\
          <button class="chip" :class="{active: tab===\'types\'}" @click="tab=\'types\'">ประเภทสินค้า</button>\
          <button class="chip" :class="{active: tab===\'due\'}" @click="tab=\'due\'">กำหนดชำระ</button>\
          <button class="chip" v-if="isAdmin" :class="{active: tab===\'users\'}" @click="tab=\'users\'">ผู้ใช้</button>\
          <button class="chip" :class="{active: tab===\'pass\'}" @click="tab=\'pass\'">รหัสผ่าน</button>\
          <button class="chip" :class="{active: tab===\'conn\'}" @click="tab=\'conn\'">การเชื่อมต่อ</button>\
        </div>\
        <div v-if="tab===\'types\'" class="card">\
          <div class="card-title">ประเภทสินค้า</div>\
          <div v-for="t in store.data.types" :key="t.id" class="list-row"><div class="grow title">{{ t.name }}</div></div>\
          <form class="row mt-4" @submit.prevent="saveType">\
            <input class="input" style="max-width:240px" v-model="typeForm.name" placeholder="ชื่อประเภทใหม่" aria-label="ชื่อประเภทใหม่" />\
            <button class="btn sm" type="submit">เพิ่ม</button>\
          </form>\
        </div>\
        <div v-if="tab===\'due\'" class="card">\
          <div class="card-title">กำหนดชำระ</div>\
          <div v-for="d in store.data.due" :key="d.id" class="list-row">\
            <div class="grow"><span class="title">{{ d.title }}</span> <span class="muted" style="font-size:var(--text-xs)">{{ d.due }} {{ d.unit === \'month\' ? \'เดือน\' : d.unit === \'day\' ? \'วัน\' : \'\' }}</span></div>\
          </div>\
          <form class="row mt-4" @submit.prevent="saveDue">\
            <input class="input" style="max-width:120px" type="number" v-model.number="dueForm.due" aria-label="จำนวนวัน" />\
            <input class="input" style="max-width:200px" v-model="dueForm.title" placeholder="ชื่อเช่น ราย 15 วัน" aria-label="ชื่อกำหนดชำระ" />\
            <button class="btn sm" type="submit">เพิ่ม</button>\
          </form>\
          <p class="hint" style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:8px">หมายเหตุ: 30 = คิดรายเดือน (บวก 1 เดือนตามปฏิทิน), อื่น ๆ = บวกตามจำนวนวัน</p>\
        </div>\
        <div v-if="tab===\'users\' && isAdmin" class="card">\
          <div class="card-title">ผู้ใช้</div>\
          <div v-for="u in users" :key="u.id" class="list-row">\
            <div class="grow"><div class="title">{{ u.name }} <span class="badge" :class="u.role===\'admin\'?\'gold\':\'grey\'">{{ u.role === \'admin\' ? \'ผู้ดูแล\' : \'พนักงาน\' }}</span></div><div class="sub">{{ u.email }}</div></div>\
            <span v-if="!active(u)" class="badge pink">ปิดใช้งาน</span>\
            <button class="btn ghost sm" v-if="u.id !== store.user.id" @click="toggleUser(u)">{{ active(u) ? \'ปิดใช้งาน\' : \'เปิดใช้งาน\' }}</button>\
          </div>\
          <form @submit.prevent="saveUser">\
            <div class="grid grid-2 mt-4">\
              <div class="field"><label for="u-name">ชื่อ</label><input id="u-name" class="input" v-model="userForm.name" /></div>\
              <div class="field"><label for="u-email">อีเมล</label><input id="u-email" class="input" type="email" v-model="userForm.email" /></div>\
              <div class="field"><label for="u-pass">รหัสผ่าน (6 ตัวขึ้นไป)</label><input id="u-pass" class="input" type="password" v-model="userForm.password" /></div>\
              <div class="field"><label for="u-role">สิทธิ์</label><select id="u-role" class="input" v-model="userForm.role"><option value="staff">พนักงาน</option><option value="admin">ผู้ดูแล</option></select></div>\
            </div>\
            <button class="btn" type="submit">เพิ่มผู้ใช้</button>\
          </form>\
        </div>\
        <div v-if="tab===\'pass\'" class="card">\
          <div class="card-title">เปลี่ยนรหัสผ่านของฉัน</div>\
          <form @submit.prevent="changePass">\
            <div class="field"><label for="cp-old">รหัสผ่านปัจจุบัน</label><input id="cp-old" class="input" type="password" v-model="passForm.current" /></div>\
            <div class="field"><label for="cp-new">รหัสผ่านใหม่</label><input id="cp-new" class="input" type="password" v-model="passForm.next" /></div>\
            <button class="btn" type="submit">เปลี่ยนรหัสผ่าน</button>\
          </form>\
        </div>\
        <div v-if="tab===\'conn\'" class="card">\
          <div class="card-title">การเชื่อมต่อ</div>\
          <p style="font-size:var(--text-sm)">โหมดปัจจุบัน: <b>{{ store.mode === \'demo\' ? \'ทดลอง (ข้อมูลตัวอย่าง รีเฟรชแล้วหาย)\' : \'เชื่อม Google Sheets จริง\' }}</b></p>\
          <div class="mt-4">\
            <button class="btn danger" @click="disconnect">ออกและล้างการเชื่อมต่อ</button>\
          </div>\
        </div>\
      </div>'
  }

  /* ---------- คู่มือ ---------- */

  var Guide = {
    data: function () {
      return {
        store: store,
        selectedGuide: 'cloudflare',
        d1Step: 1,
        d1DatabaseName: 'pawnshop',
        d1DatabaseId: ''
      }
    },
    computed: {
      d1CreateCommand: function () {
        return 'wrangler d1 create ' + this.d1DatabaseName
      },
      d1SchemaCommand: function () {
        return 'wrangler d1 execute ' + this.d1DatabaseName + ' --remote --file=cloudflare/schema.sql --config cloudflare/wrangler.toml'
      },
      d1DeployCommand: function () {
        return 'node scripts/build-cloudflare.js\nwrangler deploy --config cloudflare/wrangler.toml'
      },
      d1WranglerConfig: function () {
        return [
          'name = "pawnshop-api"',
          'main = "worker.js"',
          'compatibility_date = "2026-10-28"',
          '',
          '[[d1_databases]]',
          'binding = "DB"',
          'database_name = "' + this.d1DatabaseName + '"',
          'database_id = "' + this.d1DatabaseId + '"'
        ].join('\n')
      }
    },
    methods: {
      validD1DatabaseName: function () {
        return /^[A-Za-z0-9_-]{1,63}$/.test(this.d1DatabaseName)
      },
      validD1DatabaseId: function () {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.d1DatabaseId)
      },
      goD1Step: function (step) {
        if (step > 1 && !this.validD1DatabaseName()) {
          snack('ชื่อฐานข้อมูลใช้ได้เฉพาะ A-Z, a-z, 0-9, _ และ - (ไม่เกิน 63 ตัว)', true)
          return
        }
        if (step > 2 && !this.validD1DatabaseId()) {
          snack('กรุณาวาง Database ID รูปแบบ UUID จากผลลัพธ์คำสั่งสร้าง D1', true)
          return
        }
        this.d1Step = Math.max(1, Math.min(4, step))
      },
      copyD1: async function (text, label) {
        try {
          await navigator.clipboard.writeText(text)
          snack('คัดลอก' + label + 'แล้ว')
        } catch (error) {
          snack('คัดลอกไม่สำเร็จ กรุณาเลือกข้อความแล้วคัดลอกด้วยตนเอง', true)
        }
      },
      copyCode: async function () {
        try {
          var text = (typeof window.PAWN_CODE_GS === 'string' && window.PAWN_CODE_GS.length > 1000)
            ? window.PAWN_CODE_GS
            : ''
          if (!text) {
            var res = await fetch('Code.gs')
            text = await res.text()
          }
          await navigator.clipboard.writeText(text)
          snack('คัดลอกโค้ด Code.gs แล้ว (' + Math.round(text.length / 1024) + ' KB) — นำไปวางใน Apps Script')
        } catch (e) {
          snack('คัดลอกไม่สำเร็จ — เปิดไฟล์ Code.gs ในแท็บใหม่แล้วเลือกทั้งหมด (Ctrl+A, Ctrl+C)', true)
        }
      }
    },
    template: '\
      <div>\
        <button v-if="!store.user" class="btn ghost sm mb-4" @click="$go(\'dashboard\')">← กลับหน้าเข้าสู่ระบบ</button>\
        <h2 class="page-title">คู่มือเชื่อมต่อฐานข้อมูล</h2>\
        <p class="page-sub">เลือกวิธีเชื่อมต่อที่ต้องการใช้งาน</p>\
        <div class="row mb-4" role="tablist" aria-label="เลือกคู่มือการเชื่อมต่อ">\
          <button class="btn sm" :class="selectedGuide===\'cloudflare\' ? \'gold\' : \'ghost\'" role="tab" :aria-selected="selectedGuide===\'cloudflare\'" @click="selectedGuide=\'cloudflare\'">Cloudflare D1</button>\
          <button class="btn sm" :class="selectedGuide===\'google\' ? \'gold\' : \'ghost\'" role="tab" :aria-selected="selectedGuide===\'google\'" @click="selectedGuide=\'google\'">Google Sheets</button>\
        </div>\
        <div v-if="selectedGuide===\'cloudflare\'" class="card">\
          <div class="card-title">คู่มือเชื่อมต่อ Cloudflare D1</div>\
          <p style="font-size:var(--text-sm)">ใช้ Worker เป็นตัวกลางให้แอปติดต่อฐานข้อมูล D1 โดยไม่เปิดฐานข้อมูลให้เข้าใช้งานโดยตรง</p>\
          <div class="card mt-4 d1-wizard">\
            <div class="card-title">ตัวช่วยสร้างฐานข้อมูล D1</div>\
            <p class="page-sub">ทำตาม 4 ขั้นตอนเพื่อสร้าง D1 ใหม่และผูกเข้ากับ Worker โดยคำสั่งจะทำงานบนเครื่องของคุณ ไม่ต้องใส่ API token ในเว็บ</p>\
            <div class="d1-wizard-steps" aria-label="ขั้นตอนสร้างฐานข้อมูล D1">\
              <button v-for="step in 4" :key="step" type="button" class="chip" :class="{active: d1Step===step}" :aria-current="d1Step===step ? \'step\' : null" @click="goD1Step(step)">{{ step }}. {{ [\'สร้าง D1\', \'ผูกฐานข้อมูล\', \'เตรียมตาราง\', \'Deploy Worker\'][step-1] }}</button>\
            </div>\
            <div v-if="d1Step===1" class="d1-wizard-panel">\
              <h3>ขั้นตอน 1: สร้างฐานข้อมูล D1</h3>\
              <p>ติดตั้ง Wrangler และเข้าสู่ระบบ Cloudflare ก่อน (ทำครั้งเดียว) จากนั้นเปิด PowerShell ที่โฟลเดอร์โครงการ</p>\
              <pre class="code-box">npm install --global wrangler\nwrangler login</pre>\
              <label class="field"><span>ชื่อฐานข้อมูล</span><input class="input" v-model.trim="d1DatabaseName" maxlength="63" pattern="[A-Za-z0-9_-]+" autocomplete="off" /></label>\
              <p v-if="!validD1DatabaseName()" class="err">ใช้ได้เฉพาะ A-Z, a-z, 0-9, _ และ - ความยาวไม่เกิน 63 ตัว</p>\
              <pre class="code-box">{{ d1CreateCommand }}</pre>\
              <button type="button" class="btn sm outline" :disabled="!validD1DatabaseName()" @click="copyD1(d1CreateCommand, \'คำสั่งสร้าง D1 \')">คัดลอกคำสั่งสร้าง D1</button>\
              <p class="hint mt-4">รันคำสั่งใน PowerShell แล้วคัดลอกค่า <code>database_id</code> ที่ Wrangler แสดงไว้เพื่อใช้ขั้นตอนถัดไป</p>\
            </div>\
            <div v-else-if="d1Step===2" class="d1-wizard-panel">\
              <h3>ขั้นตอน 2: ผูก D1 กับ Worker</h3>\
              <label class="field"><span>Database ID จาก Wrangler</span><input class="input" v-model.trim="d1DatabaseId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" /></label>\
              <p v-if="d1DatabaseId && !validD1DatabaseId()" class="err">Database ID ต้องเป็น UUID ที่ได้จากคำสั่งสร้าง D1</p>\
              <p>แทนที่เนื้อหาใน <code>cloudflare/wrangler.toml</code> ด้วย config นี้ หรือแก้เฉพาะค่าฐานข้อมูลให้ตรงกัน:</p>\
              <pre class="code-box">{{ d1WranglerConfig }}</pre>\
              <button type="button" class="btn sm outline" :disabled="!validD1DatabaseId() || !validD1DatabaseName()" @click="copyD1(d1WranglerConfig, \'ค่า config \')">คัดลอก config</button>\
              <p class="hint mt-4">อย่าเผยแพร่ Database ID พร้อมข้อมูลลับอื่น และอย่าใส่ API token ลงในไฟล์หรือหน้าเว็บ</p>\
            </div>\
            <div v-else-if="d1Step===3" class="d1-wizard-panel">\
              <h3>ขั้นตอน 3: สร้างตารางของแอป</h3>\
              <p>ตรวจว่าแก้ <code>wrangler.toml</code> และใส่ Database ID ที่ถูกต้องแล้ว คำสั่งนี้สร้างตารางแอปและตาราง session โดยไม่ลบข้อมูลเดิม</p>\
              <pre class="code-box">{{ d1SchemaCommand }}</pre>\
              <button type="button" class="btn sm outline" :disabled="!validD1DatabaseId() || !validD1DatabaseName()" @click="copyD1(d1SchemaCommand, \'คำสั่งสร้างตาราง \')">คัดลอกคำสั่งสร้างตาราง</button>\
              <p class="hint mt-4">วิซาร์ดนี้สำหรับ D1 ใหม่ หากฐานข้อมูลมีข้อมูลเดิมอยู่แล้ว ให้สำรองข้อมูลและตรวจสอบ schema ก่อนดำเนินการ</p>\
            </div>\
            <div v-else class="d1-wizard-panel">\
              <h3>ขั้นตอน 4: Build และ Deploy Worker</h3>\
              <p>รันคำสั่งต่อไปนี้จากโฟลเดอร์หลักของโครงการ:</p>\
              <pre class="code-box">{{ d1DeployCommand }}</pre>\
              <button type="button" class="btn sm outline" @click="copyD1(d1DeployCommand, \'คำสั่ง Build และ Deploy \')">คัดลอกคำสั่ง Build และ Deploy</button>\
              <p class="hint mt-4">หลัง deploy ตั้งค่า <code>SETUP_SECRET</code> และสร้างบัญชีผู้ดูแลตามคู่มือด้านล่าง แล้วนำ URL Worker ไปเชื่อมต่อกับแอป</p>\
            </div>\
            <div class="d1-wizard-actions">\
              <button type="button" class="btn ghost sm" :disabled="d1Step===1" @click="goD1Step(d1Step-1)">ย้อนกลับ</button>\
              <span>ขั้นตอน {{ d1Step }} จาก 4</span>\
              <button v-if="d1Step<4" type="button" class="btn sm" @click="goD1Step(d1Step+1)">ถัดไป</button>\
              <a v-else class="btn sm" href="cloudflare/README.md" target="_blank" rel="noopener">คู่มือตั้งค่าผู้ดูแล →</a>\
            </div>\
          </div>\
          <div class="steps mt-4">\
            <div class="step"><div class="n"></div><div class="body">\
              <b>เตรียม URL ของ Cloudflare Worker</b>\
              <p>ผู้ดูแลระบบต้องสร้าง D1 และ deploy Worker ของแอปก่อน URL จะมีรูปแบบ <code>https://ชื่อ-worker.ชื่อบัญชี.workers.dev</code> ตัวอย่าง Worker ที่ใช้งานอยู่: <code>https://pawnshop-api.anubizaru.workers.dev</code></p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>เลือก Cloudflare D1 ในหน้าเชื่อมต่อ</b>\
              <p>ออกจากระบบหรือเปิดแอปใหม่ เลือกผู้ให้บริการ <b>Cloudflare D1 (Worker)</b> แล้ววาง URL ของ Worker ในช่อง URL โดยใช้ URL หลัก ไม่เติม <code>/query</code> หรือ <code>/api</code></p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>ทดสอบการเชื่อมต่อและเข้าสู่ระบบ</b>\
              <p>กด <b>เชื่อมต่อ</b> เมื่อแอปแจ้งว่าเชื่อมต่อสำเร็จ ให้เข้าสู่ระบบด้วยอีเมลและรหัสผ่านผู้ดูแล/บัญชีที่สร้างไว้ในระบบ</p>\
            </div></div>\
          </div>\
          <div class="card mt-4" style="background:var(--color-surface-2)">\
            <div class="card-title">ยังไม่มี Worker หรือฐานข้อมูล?</div>\
            <p style="font-size:var(--text-sm)">ใช้ตัวช่วยสร้างด้านบนเพื่อสร้าง D1 และเตรียมตาราง จากนั้นตั้งค่า Worker และ deploy ก่อน การเชื่อมต่อจากหน้านี้อย่างเดียวไม่สามารถสร้างบัญชีผู้ดูแลได้</p>\
            <p class="mt-4" style="font-size:var(--text-sm)"><a href="cloudflare/README.md" target="_blank" rel="noopener">เปิดคู่มือติดตั้งและ deploy สำหรับผู้ดูแลระบบ →</a></p>\
          </div>\
          <div class="card mt-4">\
            <div class="card-title">ข้อควรทราบ</div>\
            <ul style="font-size:var(--text-sm);color:var(--color-text-muted);padding-left:20px;line-height:1.9">\
              <li>ใช้ URL แบบ HTTPS ของ Worker เท่านั้น และอย่าเปิดเผยรหัสลับสำหรับตั้งค่า Worker</li>\
              <li>ถ้าฐานข้อมูลมีข้อมูลหรือบัญชีผู้ใช้อยู่แล้ว อย่ารันขั้นตอนเริ่มต้นระบบซ้ำ</li>\
              <li>ข้อมูลจะถูกบันทึกใน D1 ที่ Worker ผูกไว้ ตรวจสอบให้แน่ใจว่าเป็นฐานข้อมูลของร้านที่ถูกต้อง</li>\
            </ul>\
          </div>\
        </div>\
        <div v-else class="card">\
          <h2 class="page-title">คู่มือเชื่อมต่อ Google Sheets</h2>\
          <p class="page-sub">ใช้เวลาตั้งค่าประมาณ 10 นาที ทำครั้งเดียว ไม่มีค่าใช้จ่าย</p>\
          <div class="steps">\
            <div class="step"><div class="n"></div><div class="body">\
              <b>สร้าง Google Sheet ใหม่</b>\
              <p>เข้า <a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> ตั้งชื่อเช่น "บัญชีร้านรับจำนำ" — ชีตนี้จะเป็นฐานข้อมูลของคุณ</p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>เปิด Apps Script</b>\
              <p>ในชีต: ส่วนขยาย (Extensions) → Apps Script จะเปิดหน้าเขียนโค้ดขึ้นมา ลบโค้ดตัวอย่างออก</p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>วางโค้ด Code.gs</b>\
              <p><button class="btn gold sm" @click="copyCode" data-testid="button-copy-code">คัดลอกโค้ดทั้งหมด</button> แล้ววาง (Ctrl+V) ในหน้า Apps Script</p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>ตั้งอีเมลผู้ดูแลและรัน setup</b>\
              <p>ในโค้ด แก้ <code>var ADMIN_EMAIL = \'admin@example.com\'</code> เป็นอีเมลของคุณ แล้วกดปุ่ม Run เลือกฟังก์ชัน <code>setup</code> ครั้งแรกจะขอสิทธิ์ — กดอนุญาต (Advanced → ไปต่อ) จะมี popup แจ้งรหัสผ่าน admin ที่สร้างให้ จดไว้ (ถ้าไม่มี popup ให้เปิด Execution log ด้านล่าง editor — รหัสจะอยู่ในนั้น) และแนะนำให้ตั้ง Project settings → Time zone เป็น Bangkok</p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>Deploy เป็น Web App</b>\
              <p>ขวาบน: Deploy → New deployment → เลือก Web app → <b>Execute as: Me</b>, <b>Who has access: Anyone</b> → Deploy แล้วคัดลอก URL ที่ลงท้ายด้วย <code>/exec</code></p>\
            </div></div>\
            <div class="step"><div class="n"></div><div class="body">\
              <b>เชื่อมในแอปนี้</b>\
              <p>กด "เปลี่ยนการเชื่อมต่อ" ในหน้าเข้าสู่ระบบ วางลิงก์ แล้วเข้าสู่ระบบด้วยอีเมล + รหัสผ่านจากขั้นตอน setup</p>\
            </div></div>\
          </div>\
        </div>\
        </div>\
        <div v-if="selectedGuide===\'google\'" class="card mt-4">\
          <div class="card-title">หมายเหตุสำคัญ</div>\
          <ul style="font-size:var(--text-sm);color:var(--color-text-muted);padding-left:20px;line-height:1.9">\
            <li>ข้อมูลทั้งหมดอยู่ใน Google Sheet ของคุณเอง — ดูและแก้ไขตรง ๆ ในชีตได้</li>\
            <li>ถ้าแก้โค้ดใน Apps Script หลัง deploy ต้อง Deploy → Manage deployments → แก้ไข → Version: New เสมอ</li>\
            <li>แชร์ชีตให้คนอื่นได้ แต่การเข้าแก้ข้อมูลควรทำผ่านแอปเพื่อความถูกต้องของยอด</li>\
            <li>เหมาะกับร้านเดียว/ผู้ใช้ไม่มาก (Google จำกัดการเรียกใช้ต่อวัน) ถ้าขยายกิจการมาก ๆ ควรย้ายไปฐานข้อมูลจริง</li>\
          </ul>\
        </div>\
      </div>'
  }

  /* ---------- root ---------- */

  var Root = {
    data: function () { return { store: store, booting: true } },
    components: { Snackbar: Snackbar, Nav: Nav, Welcome: Welcome, Login: Login, Dashboard: Dashboard, Products: Products, ProductDetail: ProductDetail, Accounting: Accounting, Creditors: Creditors, Reports: Reports, Settings: Settings, Guide: Guide },
    computed: {
      view: function () {
        if (store.route.view === 'product') return 'ProductDetail'
        var map = { dashboard: 'Dashboard', products: 'Products', accounting: 'Accounting', creditors: 'Creditors', reports: 'Reports', settings: 'Settings', guide: 'Guide' }
        return map[store.route.view] || 'Dashboard'
      }
    },
    methods: {
      go: function (path) { location.hash = '#/' + path }
    },
    mounted: async function () {
      // ถ้าเคยบันทึก URL ไว้ พยายามกลับมาใช้โหมดจริง
      var savedUrl = lsGet('pawn_url')
      if (savedUrl) {
        try { await startReal(savedUrl, lsGet('pawn_provider') || 'apps-script') } catch (e) { /* ลิงก์ใช้ไม่ได้แล้ว เริ่มใหม่ */ }
      }
      this.booting = false
    },
    template: '\
      <div style="min-height:100dvh">\
        <div v-if="booting" style="display:grid;place-items:center;min-height:100dvh"><div class="spinner"></div></div>\
        <Welcome v-else-if="!store.api" />\
        <Guide v-else-if="!store.user && store.route.view === \'guide\'" />\
        <Login v-else-if="!store.user" />\
        <div v-else class="app-shell">\
          <Nav />\
          <div class="main" style="flex:1;min-width:0">\
            <div v-if="store.mode === \'demo\'" class="demo-banner">\
              <span>โหมดทดลอง — ข้อมูลตัวอย่างจะหายเมื่อรีเฟรชหน้า</span>\
              <button @click="store.api = null; store.mode = null; store.user = null; store.data = null">เริ่มเชื่อมต่อจริง</button>\
            </div>\
            <component :is="view" />\
          </div>\
        </div>\
        <Snackbar />\
      </div>'
  }

  var app = createApp(Root)
  // register ทุก component แบบ global เพื่อให้ component ที่ซ้อนกัน (Modal/ProductForm/FinanceDialog) ใช้ได้
  var allComponents = { Snackbar: Snackbar, FlatIcon: FlatIcon, Modal: Modal, Welcome: Welcome, Login: Login, Nav: Nav, Dashboard: Dashboard, ProductForm: ProductForm, ProductRecordDialog: ProductRecordDialog, Products: Products, FinanceDialog: FinanceDialog, ProductDetail: ProductDetail, Accounting: Accounting, Creditors: Creditors, Reports: Reports, Settings: Settings, Guide: Guide }
  Object.keys(allComponents).forEach(function (k) { app.component(k, allComponents[k]) })
  // helper ให้ทุก component เข้าถึงการเปลี่ยนหน้าแบบง่าย
  app.config.globalProperties.$go = function (path) { location.hash = '#/' + path }
  app.mount('#app')
})()
