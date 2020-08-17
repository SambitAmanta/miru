// Wish there where a easier way to get some of webtorrent's classes so i can patch stuff
// const WebTorrent = require('webtorrent')
// const { Torrent } = WebTorrent

const client = new WebTorrent(),
    dummyTorrent = client.add('06d67cc41f44fd57241551b6d95c2d1de38121ae'),
    torrentPrototype = Object.getPrototypeOf(dummyTorrent),
      announceList = [
        ['udp://tracker.openbittorrent.com:80'],
        ['udp://tracker.internetwarriors.net:1337'],
        ['udp://tracker.leechers-paradise.org:6969'],
        ['udp://tracker.coppersurfer.tk:6969'],
        ['udp://exodus.desync.com:6969'],
        ['wss://tracker.webtorrent.io'],
        ['wss://tracker.btorrent.xyz'],
        ['wss://tracker.openwebtorrent.com'],
        ['wss://tracker.fastcast.nz']
    ]
client.remove('06d67cc41f44fd57241551b6d95c2d1de38121ae')


WEBTORRENT_ANNOUNCE = announceList
    .map(function (arr) {
        return arr[0]
    })
    .filter(function (url) {
        return url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0
    })

function getPageHTML(title, pageHtml) {
    return "<!DOCTYPE html><html><head><meta><title>" + title + "</title></head><body>" + pageHtml + "<body></html>";
}

// From https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
function encodeRFC5987(str) {
    return encodeURIComponent(str)
        // Note that although RFC3986 reserves "!", RFC5987 does not,
        // so we do not need to escape it
        .replace(/['()]/g, escape) // i.e., %27 %28 %29
        .replace(/\*/g, '%2A')
        // The following are not required for percent-encoding per RFC5987,
        // so we can allow for a little better readability over the wire: |`^
        .replace(/%(?:7C|60|5E)/g, unescape)
}

torrentPrototype.createServer = function (requestListener) {
    if (this.destroyed) throw new Error('torrent is destroyed')

    let registration = null
    const torrent = this

    function serveIndexPage() {
        const listHtml = torrent.files.map((file, i) =>
            `<li><a x_download="${file.name}" href="${registration.scope}webtorrent/${torrent.infoHash}/${file.path}">${file.path}</a> (${file.length} bytes)</li>`
        ).join('<br>')

        const body = getPageHTML(
            `${torrent.name} - WebTorrent`,
            `<h1>${torrent.name}</h1><ol>${listHtml}</ol>`
        )

        return {
            status: 200,
            headers: {
                'Content-Type': 'text/html'
            },
            body,
        }
    }

    function serve404Page() {
        return {
            status: 404,
            headers: {
                'Content-Type': 'text/html'
            },
            body: getPageHTML('404 - Not Found', '<h1>404 - Not Found</h1>')
        }
    }

    function serveFile(file, req) {
        const res = {
            status: 200,
            headers: {
                'Content-Type': file._getMimeType(),
                // Support range-requests
                'Accept-Ranges': 'bytes',
                // Set name of file (for "Save Page As..." dialog)
                'Content-Disposition': `inline; filename*=UTF-8''${encodeRFC5987(file.name)}`
            }
        }

        // `rangeParser` returns an array of ranges, or an error code (number) if
        // there was an error parsing the range.
        let range = rangeParser(file.length, new Headers(req.headers).get('range') || '')

        if (Array.isArray(range)) {
            res.status = 206 // indicates that range-request was understood

            // no support for multi-range request, just use the first range
            range = range[0]

            res.headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.length}`
            res.headers['Content-Length'] = `${range.end - range.start + 1}`
        } else {
            range = null
            res.headers['Content-Length'] = file.length
        }

        if (req.method === 'HEAD') res.body = ''
        else res.stream = file.createReadStream(range)

        return res
    }


    navigator.serviceWorker.addEventListener('message', evt => {
        const root = new URL(registration.scope).pathname
        const url = new URL(evt.data.url)
        const pathname = url.pathname.split(`webtorrent/${torrent.infoHash}/`)[1]
        const respond = msg => evt.ports[0].postMessage(msg)

        if (pathname === '') {
            return respond(serveIndexPage())
        }

        const file = torrent.files.find(f => f.path == decodeURIComponent(pathname))
        const res = serveFile(file, evt.data)
        if (res.stream) {
            const stream = res.stream
            delete res.stream

            stream.once('end', () => {
                respond(null) // Signal end event
                evt.ports[0].onmessage = null
            })

            evt.ports[0].onmessage = evt => {
                const chunk = stream.read()
                if (chunk === null) {
                    stream.once('readable', () => {
                        const chunk = stream.read()
                        respond(new Uint8Array(chunk))
                    })
                } else {
                    respond(new Uint8Array(chunk))
                }
            }
        }

        respond(res)
    })

    const res = {
        listen(port) {
            const scope = `./`
            res.scope = scope
            return navigator.serviceWorker.getRegistration(scope).then(swReg => {
                return swReg || navigator.serviceWorker.register('sw.js', {
                    scope
                })
            }).then(swReg => {
                registration = swReg
                res.scope = registration.scope
                res.registration = registration
                let swRegTmp = swReg.installing || swReg.waiting

                if (swReg.active)
                    return

                return new Promise(rs => {
                    swRegTmp.onstatechange = () => {
                        if (swRegTmp.state === 'activated') rs()
                    }
                })
            })
        },
        close() {
            registration && registration.unregister()
        }
    }

    return res
}