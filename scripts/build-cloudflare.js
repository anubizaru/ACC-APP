const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const sources = [
  'cloudflare/worker-template.js',
  'js/logic.js',
  'js/pbkdf2.js',
  'gas/backend.js'
]

const bundle = sources
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n\n')

fs.writeFileSync(path.join(root, 'cloudflare/worker.js'), bundle, 'utf8')
console.log('Built cloudflare/worker.js')
