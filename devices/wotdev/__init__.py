"""Small helper package shared by the Python WoT devices."""
import asyncio
import logging
import signal
import sys
import time

from .config import PROJECT_ROOT, load_config, load_td  # noqa: F401
from .directory import DirectoryRegistrar
from .runtime import ThingRuntime, stop_all_hubs  # noqa: F401


def now_ms() -> float:
    return time.time() * 1000.0


def setup_logging(name: str):
    logging.basicConfig(
        level=logging.INFO,
        format=f"%(asctime)s [{name}] %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    return logging.getLogger(name)


async def run_device(cfg, things, background=()):
    """Start ThingRuntimes, register their TDs, run background coroutines until SIGINT/SIGTERM."""
    log = logging.getLogger("wotdev")
    for thing in things:
        await thing.start()
    registrar = DirectoryRegistrar(cfg.DIRECTORY_URL, cfg.int("DIRECTORY_TTL_S", 60))
    await registrar.register(*[t.td for t in things])

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    tasks = [asyncio.create_task(coro) for coro in background]
    log.info("running - press Ctrl+C to stop")
    await stop.wait()
    log.info("shutting down")
    for t in tasks:
        t.cancel()
    await registrar.unregister_all()
    await stop_all_hubs()
