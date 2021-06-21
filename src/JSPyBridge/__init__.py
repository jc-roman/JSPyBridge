# This file contains all the exposed modules
from . import config, proxy, events, decorator
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
DemoClass = config.global_jsi.DemoClass
on = config.executor.on
off = config.executor.off

def AsyncTask(fn):
    fn.is_async_task = True
    return config.event_loop.startThread(fn)

def On(emitter, event, handler=None):
    # print("On", emitter, event,onEvent)
    if handler:
        return on(emitter, event, handler)
    def decor(fn):
        on(emitter, event, fn)
        return fn
    return decor