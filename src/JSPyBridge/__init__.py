# This file contains all the exposed modules
from . import config, proxy, events
import threading, time, atexit


def init():
    config.event_loop = events.EventLoop()
    config.event_thread = threading.Thread(target=config.event_loop.loop, args=(), daemon=True)
    config.event_thread.start()
    config.executor = proxy.Executor(config.event_loop)
    config.global_jsi = proxy.Proxy(config.executor, 0)
    atexit.register(config.event_loop.on_exit)


init()


def require(name):
    return config.global_jsi.require(name)


console = config.global_jsi.console

def AsyncTask(fn):
    fn.is_async_task = True
    return config.event_loop.startThread(fn)


# You must use this Once decorator for an EventEmitter in Node.js, otherwise
# you will not be able to off an emitter.
def On(emitter, event):
    # print("On", emitter, event,onEvent)
    def decor(fn):
        emitter.on(event, fn)
        # We need to do some special things here. Because each Python object 
        # on the JS side is unique, EventEmitter is unable to equality check
        # when using .off. So instead we need to avoid the creation of a new
        # PyObject on the JS side. To do that, we need to persist the FFID for
        # this object. Since JS is the autoritative side, this FFID going out
        # of refrence on the JS side will cause it to be destoryed on the Python
        # side. Normally this would be an issue, however it's fine here.
        ffid = getattr(fn, 'iffid')
        setattr(fn, 'ffid', ffid)
        config.event_loop.callbacks[ffid] = fn
        return fn

    return decor

# The extra logic for this once function is basically just to prevent the program
# from exiting until the event is triggered at least once.
def Once(emitter, event):
    def decor(fn):
        i = hash(fn)
        def handler(*args, **kwargs):
            fn(*args, **kwargs)
            del config.event_loop.callbacks[i]
        emitter.once(event, handler)
        config.event_loop.callbacks[i] = handler
    return decor

def off(emitter, event, handler):
    emitter.off(event, handler)
    del config.event_loop.callbacks[getattr(handler, 'ffid')]
