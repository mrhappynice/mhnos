// src/runtime/poly/http.js
import { EventEmitter } from 'https://esm.sh/events';

class IncomingMessage extends EventEmitter {
    constructor(reqData) {
        super();
        this.method = reqData.method || 'GET';
        this.url = reqData.url || '/';
        this.headers = reqData.headers || {};
        this.headers['host'] = 'localhost:3000';
        this.socket = { destroy: () => {}, remoteAddress: '127.0.0.1' };
        this.connection = this.socket;
    }
}

class ServerResponse extends EventEmitter {
    constructor(onEnd) {
        super();
        this.statusCode = 200;
        this._headers = {}; 
        this.headersSent = false;
        this.finished = false;
        this._onEnd = onEnd;
        this.chunks = [];
    }
    
    setHeader(name, value) {
        if(this.headersSent) return;
        this._headers[name.toLowerCase()] = value;
    }
    
    getHeader(name) {
        return this._headers[name.toLowerCase()];
    }
    
    removeHeader(name) {
        delete this._headers[name.toLowerCase()];
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        if(headers) Object.assign(this._headers, headers);
        this.headersSent = true;
    }
    
    write(chunk) {
        this.chunks.push(chunk);
    }
    
    end(chunk) {
        if(chunk) this.chunks.push(chunk);
        this.finished = true;
        this.emit('finish');
        if(this._onEnd) this._onEnd({
            statusCode: this.statusCode,
            headers: this._headers,
            chunks: this.chunks
        });
    }
}

export default {
    IncomingMessage,
    ServerResponse,
    METHODS: ['GET', 'POST', 'PUT', 'DELETE'],
    createServer: (handler) => {
        const server = new EventEmitter();
        server.listen = (port, cb) => {
            self.postMessage({ type: 'SYSCALL_NET_LISTEN', payload: { port } });
            if (!self.__openPorts) self.__openPorts = new Map();
            self.__openPorts.set(port, (reqData) => {
                const req = new IncomingMessage(reqData);
                const res = new ServerResponse((final) => {
                    let body = final.chunks.join('');
                    if(self.Buffer && final.chunks.some(c => Buffer.isBuffer(c))) {
                         body = Buffer.concat(final.chunks.map(c => typeof c === 'string' ? Buffer.from(c) : c));
                    }
                    const transfer = (body && body.buffer instanceof ArrayBuffer) ? [body.buffer] : [];
                    self.postMessage({
                        type: 'HTTP_RESPONSE',
                        payload: {
                            reqId: reqData.reqId,
                            statusCode: final.statusCode,
                            headers: final.headers,
                            body: body
                        }
                    }, transfer);
                });
                if(handler) handler(req, res);
            });
            if (cb) setTimeout(cb, 10);
            return server;
        };
        return server;
    }
};