const { StdioCom } = process.platform == 'win32' ? require('./StdioCom') : require('./IpcPipeCom')
const { join, resolve } = require('path')
const { PyClass, Bridge } = require('./Bridge')
const getCaller = require('caller')

const com = new StdioCom()
const bridge = new Bridge(com)
const root = bridge.makePyObject(0)

async function py(tokens, ...replacements) {
  const vars = {} // List of locals
  let nstr = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const repl = await replacements[i]
    if (repl) {
      const v = '__' + i
      vars[v] = (repl.ffid ? ({ ffid: repl.ffid }) : repl)
      nstr += token + v
    } else {
      nstr += token
    }
  }
  return root.eval(nstr, null, vars)
}

module.exports = {
  PyClass,
  root,
  py,
  python (file) {
    if (file.startsWith('/') || file.startsWith('./') || file.startsWith('../') || file.includes(':')) {
      if (file.startsWith('.')) {
        const caller = getCaller(1)
        const callerDir = caller.replace('file://', '').split('/').slice(0, -1).join('/')
        // console.log('Caller', caller, callerDir)
        file = join(callerDir, file)
      }
      const importPath = resolve(file)
      const fname = file.split('/').pop() || file
      // console.log('Loading', fname, importPath)
      return root.fileImport(fname, importPath)
    }
    return root.python(file)
  },
  com
}
module.exports.python.exit = () => com.end()
