/* =========================================================
 *  api.js — ชั้นเชื่อมต่อ API
 *  โหมดจริง: POST ไป Apps Script (text/plain เพื่อไม่ trigger preflight)
 *  โหมดทดลอง: เรียก DemoEngine (Code.gs ตัวจริงในเบราว์เซอร์)
 * ========================================================= */

var PawnAPI = (function () {
  'use strict'

  function realApi(url) {
    return {
      demo: false,
      url: url,
      async call(action, data, requestId, token) {
        var body = JSON.stringify({ action: action, data: data || {}, requestId: requestId, token: token })
        var res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: body,
          redirect: 'follow'
        })
        if (!res.ok) throw new Error('http-' + res.status)
        var text = await res.text()
        try {
          return JSON.parse(text)
        } catch (err) {
          throw new Error('bad-response')
        }
      }
    }
  }

  function demoApi() {
    return {
      demo: true,
      async call(action, data, requestId, token) {
        return window.DemoEngine.route_({ action: action, data: data, requestId: requestId, token: token })
      }
    }
  }

  return {
    real: realApi,
    demo: demoApi
  }
})()
