const fs = require('node:fs')
const path = require('node:path')

module.exports = function probe(source) {
  const name = path.basename(this.resourcePath, '.probe')
  if (name === 'no-cache') this.cacheable(false)
  if (name === 'cacheable') this.cacheable(true)

  const scratch = path.join(this.rootContext, '.repro')
  const value = {
    name,
    source: source.trim(),
    external: fs.readFileSync(path.join(scratch, 'external.txt'), 'utf8').trim(),
  }
  fs.appendFileSync(
    path.join(scratch, 'loader.jsonl'),
    JSON.stringify({ ...value, pid: process.pid }) + '\n'
  )
  return `export default ${JSON.stringify(value)};`
}
