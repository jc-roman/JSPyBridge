const { StdioCom } = require('./IpcPipeCom')
const { resolve } = require('path')
const util = require('util')
const log = () => {}

const REQ_TIMEOUT = 10000

class BridgeException extends Error {
  constructor(...a) {
    super(...a)
    this.message += ` Python didn't respond in time (${REQ_TIMEOUT}ms), look above for any Python errors. If no errors, the API call hung.`
    // We'll fix the stack trace once this is shipped.
  }
}

async function waitFor(cb, withTimeout, onTimeout) {
  let t
  const ret = await Promise.race([
    new Promise(resolve => cb(resolve)),
    new Promise(resolve => { t = setTimeout(() => resolve('timeout'), withTimeout) })
  ])
  clearTimeout(t)
  if (ret === 'timeout') onTimeout()
  return ret
}

const nextReq = () => (performance.now() * 10) | 0

class Bridge {
  constructor(com) {
    this.com = com
    // This is called on GC
    this.finalizer = new FinalizationRegistry(ffid => {
      this.free(ffid)
    })
  }

  request(req, cb) {
    // When we call Python functions with Proxy paramaters, we need to just send the FFID
    // so it can be mapped on the python side.
    const nval = []
    for (const val of req.val) {
      if (val?.ffid) {
        nval.push({ ffid: val.ffid })
      } else {
        nval.push(val)
      }
    }
    req.val = nval
    this.com.write(req, cb)
  }

  async len(ffid, stack) {
    const req = { r: nextReq(), action: 'length', ffid: ffid, key: stack, val: '' }
    const resp = await waitFor(cb => this.request(req, cb), REQ_TIMEOUT, () => {
      throw new BridgeException(`Attempt to access '${stack.join('.')}' failed.`)
    })
    return resp.val
  }

  async get(ffid, stack, args) {
    const req = { r: nextReq(), action: 'get', ffid: ffid, key: stack, val: args }

    const resp = await waitFor(cb => this.request(req, cb), REQ_TIMEOUT, () => {
      throw new BridgeException(`Attempt to access '${stack.join('.')}' failed.`)
    })
    switch (resp.key) {
      case 'string':
      case 'int':
        return resp.val // Primitives don't need wrapping
      default: {
        const py = this.makePyObject(resp.val, resp.sig)
        this.queueForCollection(resp.val, py)
        return py
      }
    }
  }

  async call(ffid, stack, args) {
    const req = { r: nextReq(), action: 'call', ffid: ffid, key: stack, val: args }
    const resp = await waitFor(cb => this.request(req, cb), REQ_TIMEOUT, () => {
      throw new BridgeException(`Attempt to access '${stack.join('.')}' failed.`)
    })
    log('call', ffid, stack, args, resp)
    switch (resp.key) {
      case 'string':
      case 'int':
        return resp.val // Primitives don't need wrapping
      default: {
        const py = this.makePyObject(resp.val, resp.sig)
        this.queueForCollection(resp.val, py)
        return py
      }
    }
  }

  async inspect(ffid, stack) {
    const req = { r: nextReq(), action: 'inspect', ffid: ffid, key: stack, val: '' }
    const resp = await waitFor(cb => this.request(req, cb), REQ_TIMEOUT, () => {
      throw new BridgeException(`Attempt to access '${stack.join('.')}' failed.`)
    })
    return resp.val
  }

  async free(ffid) {
    const req = { r: nextReq(), action: 'free', ffid: ffid, key: '', val: '' }
    const resp = await waitFor(cb => this.request(req, cb), REQ_TIMEOUT, () => {
      // Allow a GC time out, it's probably because the Python process died
      // throw new BridgeException('Attempt to GC failed.')
    })
    return resp.val
  }

  queueForCollection(ffid, val) {
    this.finalizer.register(val, ffid)
  }

  makePyObject(ffid, inspectString) {
    // "Intermediate" objects are returned while chaining. If the user tries to log
    // an Intermediate then we know they forgot to use await, as if they were to use
    // await, then() would be implicitly called where we wouldn't return a Proxy, but
    // a Promise. Must extend Function to be a "callable" object in JS for the Proxy.
    class Intermediate extends Function {
      constructor(callstack) {
        super()
        this.callstack = [...callstack]
      }
      [util.inspect.custom]() {
        return '\n[You must use await when calling a Python API]\n'
      }
    }
    const handler = {
      get: (target, prop, reciever) => {
        const next = new Intermediate(target.callstack)
        // log('```prop', next.callstack, prop)
        if (prop === 'ffid') return ffid
        if (prop === 'then') {
          // Avoid .then loops
          if (!next.callstack.length) {
            return undefined
          }
          return (resolve, reject) => {
            this.get(ffid, next.callstack, []).then(resolve).catch(reject)
            next.callstack = [] // Empty the callstack afer running fn
          }
        }
        if (prop === 'length') {
          return this.len(ffid, next.callstack, [])
        }
        if (typeof prop === 'symbol') {
          console.log('Get symbol', next.callstack, prop)
          if (prop == Symbol.asyncIterator) {
            // todo
          }
          return
        }
        // else if (prop.endsWith('$')) { // stop returning Proxy chain, call python
        //   callstack.push(prop.slice(0, -1))
        //   console.log('Getting method attr', callstack.join('.'))
        //   return this.get(ffid, callstack, [])
        // }
        if (Number.isInteger(parseInt(prop))) prop = parseInt(prop)
        next.callstack.push(prop)
        return new Proxy(next, handler) // no $ and not fn call, continue chaining
      },
      apply: (target, self, args) => { // Called for function call
        const ret = this.call(ffid, target.callstack, args)
        target.callstack = [] // Flush callstack to py
        return ret
      }
    }
    // A CustomLogger is just here to allow the user to console.log Python objects
    // since this must be sync, we need to call inspect in Python along with every CALL or GET
    // operation, which does bring some small overhead.
    class CustomLogger extends Function {
      constructor () {
        super()
        this.callstack = []
      }
      [util.inspect.custom]() {
        return inspectString || '(Some Python object)'
      }
    }
    return new Proxy(new CustomLogger(), handler)
  }
}

const com = new StdioCom()
const bridge = new Bridge(com)
const root = bridge.makePyObject(0)

// async function load() {
// }

module.exports = {
  root,
  python(file) {
    if (file.startsWith('/') || file.startsWith('./') || file.includes(':')) {
      const importPath = resolve(file)
      const fname = file.split('/').pop() || file
      // console.log('Loading', fname)
      return root.fileImport(fname, importPath)
    }
    return root.python(...args)
  },
  com
}