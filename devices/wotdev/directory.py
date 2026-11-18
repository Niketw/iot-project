"""Register Thing Descriptions in the Thing Description Directory (W3C WoT Discovery API).

Lifecycle per device:
    start : DELETE /things/{id}  (marks a fresh registration -> consumers re-bind)
            PUT    /things/{id}  with registration.ttl
    every TTL/3 : PUT again (heartbeat; the directory expires stale entries)
    stop  : DELETE /things/{id}
"""
import asyncio
import logging
from urllib.parse import quote

import aiohttp

log = logging.getLogger("wotdev.directory")


class DirectoryRegistrar:
    def __init__(self, directory_url: str, ttl_s: int = 60):
        self.base = directory_url.rstrip("/")
        self.ttl = int(ttl_s)
        self.tds = {}
        self._task = None
        self._session = None

    def _url(self, td_id):
        return f"{self.base}/things/{quote(td_id, safe='')}"

    async def _put(self, td):
        body = dict(td)
        body["registration"] = {"ttl": self.ttl}
        async with self._session.put(self._url(td["id"]), json=body,
                                     headers={"Content-Type": "application/td+json"}) as resp:
            if resp.status >= 300:
                text = await resp.text()
                raise RuntimeError(f"directory rejected {td['id']}: HTTP {resp.status} {text[:300]}")

    async def register(self, *tds, fresh=True):
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
        for td in tds:
            self.tds[td["id"]] = td
        sem = asyncio.Semaphore(10)

        async def one(td):
            async with sem:
                for attempt in range(60):
                    try:
                        if fresh:
                            async with self._session.delete(self._url(td["id"])):
                                pass
                        await self._put(td)
                        return
                    except RuntimeError:
                        raise
                    except Exception as exc:
                        if attempt == 0 or attempt % 10 == 0:
                            log.warning("directory not reachable (%s) - retrying", exc)
                        await asyncio.sleep(1)
                raise RuntimeError(f"could not register {td['id']}")

        await asyncio.gather(*(one(td) for td in tds))
        log.info("registered %d TD(s) at %s", len(tds), self.base)
        if self._task is None:
            self._task = asyncio.create_task(self._heartbeat())

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(max(5, self.ttl / 3))
            for td in list(self.tds.values()):
                try:
                    await self._put(td)
                except Exception as exc:
                    log.warning("heartbeat for %s failed: %s", td["id"], exc)

    async def unregister_all(self):
        if self._task:
            self._task.cancel()
        if self._session is None:
            return
        for td_id in list(self.tds):
            try:
                async with self._session.delete(self._url(td_id)):
                    pass
            except Exception:
                pass
        self.tds.clear()
        await self._session.close()
        self._session = None
