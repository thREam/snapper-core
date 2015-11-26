'use strict'

const net = require('net')
const Bufsp = require('bufsp')
const config = require('config')
const thunk = require('thunks')()
const jsonrpc = require('jsonrpc-lite')
const debug = require('debug')('snapper:rpc')

const io = require('./io')
const ilog = require('./log')
const tools = require('./tools')
const stats = require('./stats')

const DEFT_MAX_INVALID_REQ_NUM = 100

module.exports = function (app) {
  var server = net.createServer(function (socket) {
    debug('connection:', socket.remoteAddress, socket.remotePort)

    socket.bufsp = new Bufsp({
      encoding: 'utf8',
      returnString: true
    })
    socket.bufsp.socket = socket
    socket.pipe(socket.bufsp)

    socket
      .on('error', onSocketError)
      .on('end', onSocketClose)
      .on('close', onSocketClose)

    socket.bufsp
      .once('data', onAuth)
      .on('error', app.onerror)
  })

  server.clients = Object.create(null)
  server.destroy = function (callback) {
    for (let id in this.clients) this.clients[id].destroy()
    this.close(callback)
  }

  server.on('error', function (error) {
    ilog.emergency(error)
    // the application should restart if error occured
    throw error
  })
  server.listen(config.rpcPort)
  return server

  function onSocketError (err) {
    this.destroy()
    if (err.code === 'ECONNRESET') {
      // Filter invalid socket (i.e. probe socket from Server Load Balancer).
      debug('probe connection:', this.remoteAddress, err)
      return
    }
    ilog.error(err)
  }

  function onSocketClose () {
    if (this.id) delete server.clients[this.id]
  }

  function onAuth (message) {
    var socket = this.socket
    debug('message:', message)

    var res = jsonrpc.parse(message)
    if (res.type !== 'request') {
      return socket.end(socket.bufsp.encode(new Error(`Receive a unhandle message: ${message}`)))
    }

    if (res.payload.method !== 'auth') {
      // should change to 401 in next version
      res = jsonrpc.error(res.payload.id, new jsonrpc.JsonRpcError('Unauthorized: ' + message, 400))
      return socket.end(socket.bufsp.encode(JSON.stringify(res)))
    }

    // params: [tokenxxx]
    try {
      socket.token = app.verifyToken(res.payload.params[0])
      // Producer token should have producerId to be different from consumer auth.
      if (!validString(socket.token.producerId)) throw new Error('invalid signature')
      socket.id = tools.md5(res.payload.params[0])
      socket.producerId = socket.token.producerId
      res = jsonrpc.success(res.payload.id, {id: socket.id})
      socket.write(socket.bufsp.encode(JSON.stringify(res)))
    } catch (err) {
      res = jsonrpc.error(res.payload.id, new jsonrpc.JsonRpcError(err.message, 400))
      return socket.end(socket.bufsp.encode(JSON.stringify(res)))
    }
    // Socket is ready to listen.
    socket.invalidRequestCount = 0
    server.clients[socket.id] = socket
    this.on('data', onData)
  }

  function onData (message) {
    var socket = this.socket
    debug('message:', socket.producerId, message)

    var req = jsonrpc.parse(message)
    if (req.type !== 'request') {
      app.onerror(new Error(`Receive a unhandle message: ${message}`))
      socket.invalidRequestCount++
      if (socket.invalidRequestCount > DEFT_MAX_INVALID_REQ_NUM) {
        socket.end(socket.bufsp.encode(new Error('excessive invalid requests')))
      }
    } else {
      thunk(handleRPC(socket, req.payload))(function (err, res) {
        debug('response:', req.payload.id, err, res)
        var data = null
        if (err) {
          if (!(err instanceof jsonrpc.JsonRpcError)) {
            err = new jsonrpc.JsonRpcError(String(err), 500)
          }
          data = jsonrpc.error(req.payload.id, err)
        } else {
          data = jsonrpc.success(req.payload.id, res == null ? 'OK' : res)
        }
        socket.write(socket.bufsp.encode(JSON.stringify(data)))
      })
    }
  }

  function * handleRPC (socket, data) {
    switch (data.method) {
      case 'publish':
        // params: [
        //   [room1, message1],
        //   [room2, message2]
        //   ...
        // ]
        var count = 0
        while (data.params.length) {
          let param = data.params.shift()
          if (validString(param[0]) && validString(param[1])) {
            count++
            io.broadcastMessage(param[0], param[1])
          }
        }
        stats.incrProducerMessages(count)
        if (socket.invalidRequestCount) socket.invalidRequestCount--
        return count

      case 'subscribe':
        // params: [room, consumerId]
        if (!validString(data.params[0]) || !validString(data.params[1])) {
          throw jsonrpc.JsonRpcError.invalidParams()
        }
        return yield io.joinRoom(data.params[0], data.params[1])

      case 'unsubscribe':
        // params: [room, consumerId]
        if (!validString(data.params[0]) || !validString(data.params[1])) {
          throw jsonrpc.JsonRpcError.invalidParams()
        }
        return yield io.leaveRoom(data.params[0], data.params[1])

      case 'consumers':
        // params: [userId]
        if (!validString(data.params[0])) {
          throw jsonrpc.JsonRpcError.invalidParams()
        }
        return yield io.getUserConsumers(data.params[0])
    }
    socket.invalidRequestCount++
    throw jsonrpc.JsonRpcError.methodNotFound()
  }
}

function validString (str) {
  return str && typeof str === 'string'
}
