const http = require('http');
const express = require('express');
const async = require('async');
const request = require('request');
const zlib = require('zlib');
const TurtleCoind = require('turtlecoin-rpc').TurtleCoind;

const logSystem = 'turtlecoind-haCheck';
require('./exceptionWriter.js')(logSystem);

const log = function (severity, system, text, data) {
  global.log(severity, system, text, data);
}

var globals = {
    localDaemons: undefined,
    networkDaemons: undefined,
    networkPools: undefined,
};

/* Init the globals then launch the main program */
initGlobals(launch);

function launch() {
    /* Launch updaters in background */
    backgroundTasks();
    launchServer();
}

/* We do this bit synchronously so all our data is valid when we launch the
   main program - after this is done, calls are done asynchronously */
function initGlobals(callback) {
    /* Init the local daemons */
    getLocalDaemonStatus(function() {
        /* Parse the pools JSON */
        getNetworkPoolInfo(function() {
            /* Get the network daemon info */
            getNetworkDaemonStatus(function() {                
                log('info', logSystem, 'Finished initializing', []);
                /* Start the app */
                callback();
            });
        });
    });
}

function supportedPool(pool) {
    if (pool.type === "forknote") {
        return true;
    }

    if (pool.type === "node.js") {
        return true;
    }

    return false;
}

function haCheckHandler(req, res) {
    var host;

    if (req.headers['x-haproxy-server-state']){
        log('info', logSystem, req.headers['x-haproxy-server-state']);
        var regex = /name=([^;]+)/;
        var match = req.headers['x-haproxy-server-state'].match(regex);
        if (match) {host = match[1]}
    }

    /* Make sure the host header is present in the defined hosts in config */
    if (!isValidHost(host)) {
        log('info', logSystem, 'Request for host: %s, is invalid', [host])
        res.writeHead(400, {'Content-Type': 'text/html'})
        res.write(`Specified host (${host}) is not present in config!`)
        res.end();
        return;
    }

    /* Get mode height and compare to the rest of the pools */
    const modeHeight = mode(globals.networkDaemons.map(x => x.height));

    /* The host making the requests info */
    const currentDaemon = globals.localDaemons.find(x => x.host === host);

    const deviance = Math.abs(modeHeight - currentDaemon.height);
    const status = deviance <= config.localDaemonMaxDeviance;
    const statusDescription = (status) ? "UP" : "DOWN";
    const statusCode = (status) ? 200 : 503;

    log('info', logSystem, 'Request for host: %s , Mode height: %s , Daemon Height: %s , Deviance: %s , Status: %s', [host, modeHeight, currentDaemon.height, deviance, statusDescription]);

    const response = JSON.stringify({host: host, modeHeight: modeHeight, daemonHeight: currentDaemon.height, deviance: deviance, status: statusDescription});

    res.writeHead(statusCode, {'Content-Type': 'text/html'});
    res.write(response);
    res.end();
}

/* Is the host specified present in the defined hosts in config */
function isValidHost(host) {
    return config.poolHostsToDaemons.findIndex(
        pool => pool.host === host
    ) !== -1;
}

function launchServer() {
    const server = express();

    server.get('/hacheck', haCheckHandler);
    server.get('/heights', heightsHandler);

    server.listen(config.serverPort);
}

function heightsHandler(req, res) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.write(JSON.stringify(globals.networkDaemons));
    res.end();
}

function getLocalDaemonStatus(callback) {
    async.map(config.poolHostsToDaemons, getHeight, function(err, promises) {
        Promise.all(promises).then(results => {
            globals.localDaemons = results

            if (callback) {
                callback();
            }
        });
    });
}

function getNetworkDaemonStatus(callback) {
    async.map(globals.networkPools.pools.filter(supportedPool), getPoolInfo, function(err, results) {
        /* Filter null values (i.e. pools which failed to parse) */
        results = results.filter(val => val !== null);

        /* Get the mode height of all the pools now we've got all their data */
        const modeHeight = mode(results.map(x => x.height));

        /* Update the modeHeight of each entry with this new height */
        globals.networkDaemons = results.map(entry => {
            entry.mode = modeHeight;
            return entry;
        });

        if (callback) {
            callback();
        }
    });
}

function getPoolInfo(pool, callback) {
    if (pool.type === "forknote") {
        getForknotePoolInfo(pool, callback);
    } else if (pool.type === "node.js") {
        getNodeJSPoolInfo(pool, callback);
    } else {
        throw new Error('Unsupported pool type not filtered!');
    }
}

function requestToJSON(url, callback) {
    const options = {
        url: url,
        timeout: config.networkDaemonTimeout * 1000,
        strictSSL: false,
        encoding: null,
    };

    request(options, function(error, response, body) {
        if (error !== null) {
            log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [url, error]);
            return callback(undefined);
        }

        try {
            switch (response.headers['content-encoding']) {
                case 'deflate':
                    body = zlib.inflateRawSync(body).toString();
                    break;
                case 'gzip':
                    body = zlib.gunzipRawSync(body).toString();
                    break;
            }

            return callback(JSON.parse(body));

        } catch (e) {
            log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [url, e]);
            return callback(undefined);
        }
    });
}

function getForknotePoolInfo(pool, callback) {
    requestToJSON(pool.api + 'stats', function(json) {
        /* Annoyingly, if we return an error in the callback it will stop
           the processing completely. This is obviously not desired, so we
           can hack around it by returning (null, null), then filtering null
           values. */
        if (json === undefined) {
            return callback(null, null);
        }

        /* Don't divide by zero */
        const estimatedSolveTime = json.pool.hashrate == 0 ? 'Never'
                                 : json.network.difficulty / json.pool.hashrate;

        const lastFound = json.pool.lastBlockFound == 0 ? 'Never'
                        : json.pool.lastBlockFound;

        return callback(null, {
            url: pool.url,
            height: json.network.height,
            estimatedSolveTime: estimatedSolveTime,
            lastFound: lastFound,
            /* We're not filling this in yet - we want to use all the height
               values we just calculated, so lets fill it in once we're done
               with this. */
            mode: undefined,
        });
    });
}

function getNodeJSPoolInfo(pool, callback) {
    requestToJSON(pool.api + 'pool/stats', function(poolJSON) {
        requestToJSON(pool.api + 'network/stats', function(networkJSON) {
            if (poolJSON === undefined || networkJSON === undefined) {
                return callback(null, null);
            }

            return callback(null, {
                url: pool.url,
                height: networkJSON.height,
                estimatedSolveTime: networkJSON.difficulty / poolJSON.pool_statistics.hashRate,
                lastFound: secsSinceLastBlock(poolJSON.pool_statistics.lastBlockFound),
                mode: undefined,
            });
        });
    });
}

function secsSinceLastBlock(timestamp) {
    /* This technically could be in the future... */
    const lastFound = new Date(timestamp * 1000);

    return (Date.now() - lastFound) / 1000;
}

function getHeight(pool, callback) {
    const daemon = new TurtleCoind({
        host: pool.daemon.host,
        port: pool.daemon.port,
        timeout: config.poolDaemonTimeout
    });

    /* Get the height if we can */
    daemon.getHeight().then((height) => {
        return callback(null, {host: pool.host, height: height.height});
    }).catch((err) => {        
        log('info', logSystem, 'Failed to get height from %s, reason: %s', [pool.daemon.host, err]);
        return callback(null, {host: pool.host, height: 0});
    });
}

function getNetworkPoolInfo(callback) {
    requestToJSON(config.poolsJSON, function(json) {
        if (json !== undefined) {
            globals.networkPools = json;
        }

        if (callback) {
            callback();
        }
    });
}

/* Values are specified in milliseconds */
function backgroundTasks() {
    setInterval(getNetworkPoolInfo, config.poolJSONRefreshRate * 1000);
    setInterval(getLocalDaemonStatus, config.localDaemonRefreshRate * 1000);
    setInterval(getNetworkDaemonStatus, config.networkDaemonRefreshRate * 1000);
}

function mode(arr) {
    var numMapping = {};
    var greatestFreq = 0;
    var mode = 0;

    arr.forEach(function findMode(number) {
        /* Skip zero heights */
        if (number === 0) {
            return;
        }

        numMapping[number] = (numMapping[number] || 0) + 1;

        if (greatestFreq < numMapping[number]) {
            greatestFreq = numMapping[number];
            mode = number;
        }
    });

    return mode;
}
