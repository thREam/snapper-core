'use strict'

const Toa = require('toa')
const pm = require('toa-pm')
const config = require('config')
const toaToken = require('toa-token')
const debug = require('debug')('snapper')

const packageInfo = require('./package.json')
const ws = require('./services/ws')
const rpc = require('./services/rpc')
const tools = require('./services/tools')
const stats = require('./services/stats')

const app = Toa(function *() {
  debug('http request:', this.method, this.url, this.ip)

  var res = null
  var token = null
  if (this.path === '/stats') {
    try {
      token = this.token
      if (token.userId) token = token.name === 'snapper' && token
    } catch (e) {
      token = null
    }
  }
  if (token) {
    res = stats.os()
    res.stats = yield stats.clientsStats()
  } else {
    res = {
      server: packageInfo.name,
      version: packageInfo.version
    }
  }
  this.body = res
})

config.instancePort = config.port + (+process.env.NODE_APP_INSTANCE || 0)

app.connectRPC = function () {
  this.context.rpc = rpc(this)
}
app.connectWS = function () {
  this.context.ws = ws(this)
}

toaToken(app, config.tokenSecret, {
  expiresInSeconds: config.expires,
  getToken: function () {
    if (this.method !== 'GET') return
    // GET requests permits both authorization headers and signature query.
    return this.query.token
  }
})

/**
 * Start up service.
 */
app.listen(config.instancePort, config.backlog)
app.connectRPC()
app.connectWS()
// The server is finally closed and exit gracefully when all connections are ended.
pm(app, function (msg) {
  if (msg !== 'shutdown') return
  app.context.rpc.close(function () {
    app.server.close(function () {
      process.exit(0)
    })
  })
})

module.exports = app

tools.logInfo('start', {
  listen: config.instancePort,
  rpcPort: config.rpcPort,
  serverId: stats.serverId,
  appConfig: app.config
})
