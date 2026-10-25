/* =========================================================
 * pbkdf2.js — PBKDF2-HMAC-SHA256 (pure JS, ไม่พึ่งไลบรารี)
 * สำหรับใช้ใน Google Apps Script (ไม่มี crypto แบบ PBKDF2 ให้)
 * ทดสอบกับ test vectors มาตรฐานแล้ว (ดู test-logic.js)
 * ========================================================= */

/* ---------- SHA-256 (pure JS) ---------- */
var SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]

function sha256Bytes(bytes) {
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  var msg = bytes.slice()
  var bitLen = msg.length * 8
  msg.push(0x80)
  while (msg.length % 64 !== 56) msg.push(0)
  // ความยาวเป็นบิต (แกน 64 บิต — ใช้เฉพาะ 32 บิตล่าง ก็พอสำหรับข้อมูลขนาดปกติ)
  var hi = Math.floor(bitLen / 4294967296)
  var lo = bitLen >>> 0
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255)
  msg.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)

  var w = new Array(64)
  var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)) }
  for (var off = 0; off < msg.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      var j = off + i * 4
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]
    }
    for (var i2 = 16; i2 < 64; i2++) {
      var s0 = rotr(w[i2 - 15], 7) ^ rotr(w[i2 - 15], 18) ^ (w[i2 - 15] >>> 3)
      var s1 = rotr(w[i2 - 2], 17) ^ rotr(w[i2 - 2], 19) ^ (w[i2 - 2] >>> 10)
      w[i2] = (w[i2 - 16] + s0 + w[i2 - 7] + s1) >>> 0
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (var t = 0; t < 64; t++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      var ch = (e & f) ^ (~e & g)
      var t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  var out = []
  for (var k = 0; k < 8; k++) {
    out.push((H[k] >>> 24) & 255, (H[k] >>> 16) & 255, (H[k] >>> 8) & 255, H[k] & 255)
  }
  return out
}

function strBytes(s) {
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 128) out.push(c)
    else {
      // UTF-8 encode
      if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63))
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63))
    }
  }
  return out
}

function bytesHex(bytes) {
  var s = ''
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return s
}

function hmacSha256(keyBytes, dataBytes) {
  var block = 64
  var k = keyBytes.slice()
  if (k.length > block) k = sha256Bytes(k)
  while (k.length < block) k.push(0)
  var ipad = [], opad = []
  for (var i = 0; i < block; i++) {
    ipad.push(k[i] ^ 0x36)
    opad.push(k[i] ^ 0x5c)
  }
  return sha256Bytes(opad.concat(sha256Bytes(ipad.concat(dataBytes))))
}

/* ---------- PBKDF2-HMAC-SHA256 ---------- */

function pbkdf2Sha256(password, salt, iterations, dkLen) {
  var pw = strBytes(String(password))
  var st = (salt instanceof Array) ? salt.slice() : strBytes(String(salt)) // salt ต้องเป็น bytes อยู่แล้ว
  var blocks = Math.ceil(dkLen / 32)
  var dk = []
  for (var b = 1; b <= blocks; b++) {
    // U1 = PRF(P, S || INT(b))
    var u = hmacSha256(pw, st.concat([(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255]))
    var t = u.slice()
    for (var i = 1; i < iterations; i++) {
      u = hmacSha256(pw, u)
      for (var j = 0; j < t.length; j++) t[j] ^= u[j]
    }
    dk = dk.concat(t)
  }
  return dk.slice(0, dkLen)
}

function hashPassword(password, saltHex, iterations) {
  // แปลง salt (hex string) เป็น bytes ก่อนใช้
  var sb = []
  for (var i = 0; i < saltHex.length; i += 2) sb.push(parseInt(saltHex.substr(i, 2), 16))
  return bytesHex(pbkdf2Sha256(password, sb, iterations || 10000, 32))
}
