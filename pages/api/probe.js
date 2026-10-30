import noCache from '../../fixtures/no-cache.probe'
import cacheable from '../../fixtures/cacheable.probe'
import defaultCache from '../../fixtures/default.probe'
import trigger from '../../fixtures/trigger'

export default function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  response.status(200).json({ trigger, noCache, cacheable, defaultCache })
}
