const path = require('node:path')

module.exports = {
  agentRules: false,
  experimental: { agentUpgrade: false },
  turbopack: {
    root: __dirname,
    rules: {
      '*.probe': {
        loaders: ['./loaders/probe.cjs'],
        as: '*.js',
      },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.probe$/,
      use: [{ loader: path.join(__dirname, 'loaders/probe.cjs') }],
    })
    return config
  },
}
