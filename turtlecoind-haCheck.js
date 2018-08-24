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
    serviceNodes: undefined,
    networkPools: undefined,
    networkPoolList: undefined
};

/* Init the globals then launch the main program */
initGlobals();

function launch() {
    /* Launch updaters in background */
    backgroundTasks();
    launchServer();
}

/* We do this bit synchronously so all our data is valid when we launch the
   main program - after this is done, calls are done asynchronously */
function initGlobals() {
    log('info', logSystem, 'Initializing...', []);
    async.series([
        function(callback) {
            updateServiceNodes(function() {
                callback(null);
            });
        },
        function(callback){
            //Must succeed for initialization.
            updateNetworkPoolList(function(err, result) {
                callback(err);
            });
        },
        function(callback){
            updateNetworkPools(function() {
                callback(null);
            });
        }
    ], function(err, results) {
          if (err) {
              log('error', logSystem, 'Initialization error. Retrying..', []);
              setTimeout(function(){initGlobals();}, 5000);
          } else {
              log('info', logSystem, 'Initialization complete. Launching..', []);
              launch();
          }
    });
}

function isSupportedPool(pool) {
    if (pool.type === "forknote" || pool.type === "node.js") {
        return true;
    }
    return false;
}

function haCheckHandler(req, res) {
    var haName;
    var isMiningAddress = false;
    var isFailoverCheck = false;

    // HAProxy server headers take precedence
    if (req.headers['x-haproxy-server-state']) {
        log('info', logSystem, 'x-haproxy-server-state: %s', [req.headers['x-haproxy-server-state']]);
        const regex = /name=([^;]+)/;
        const match = req.headers['x-haproxy-server-state'].match(regex);
        if (match) {haName = match[1];}
        isFailoverCheck = true;
    // Check for HAProxy Node Group and Node Id
    } else if (req.params.nodeGroup && req.params.nodeId) {
        haName = req.params.nodeGroup + '/' + req.params.nodeId;
    // Check for mining address
    } else if (req.params.miningAddress) {
        haName = req.params.miningAddress;
        isMiningAddress = true;
    } else {
        log('warn', logSystem, 'Request is missing header x-haproxy-server-state or params', []);
        res.writeHead(400, {'Content-Type': 'text/html'});
        res.write(`Request is missing header x-haproxy-server-state or haName query`);
        res.end();
        return;
    }

    /* Make sure the host header is present in the defined hosts in config or we have a valid miningAddress */
    if ((!isValidhaName(haName) && !isMiningAddress) || (!isValidMiningAddress(haName) && isMiningAddress)) {
        log('info', logSystem, 'Request for haName: %s, is invalid', [haName]);
        res.writeHead(400, {'Content-Type': 'text/html'});
        res.write(`Specified name (${haName}) is not valid!`);
        res.end();
        return;
    }

    /* Get mode height and compare to the rest of the pools */
    const modeData = mode(globals.networkPools.map(x => x.height));
    const modeHeight = modeData.mode;

    var currentDaemon;

    if (!isMiningAddress) {
        currentDaemon = globals.serviceNodes.find(x => x.haName === haName);
    } else {
        currentDaemon = globals.networkPools.find(x => x.miningAddress === haName);
    }

    const deviance = Math.abs(modeHeight - currentDaemon.height);
    const status = (isFailoverCheck) ? deviance <= config.serviceNodeMaxFailoverDeviance : deviance <= config.serviceNodeMaxAlertDeviance;
    const statusDescription = (status) ? "UP" : "DOWN";
    const statusCode = (status) ? 200 : 503;

    log('info', logSystem, 'Request for haName: %s , Mode height: %s , Mode valid: %s , Mode invalid: %s , Daemon Height: %s , Deviance: %s , Status: %s', [haName, modeHeight, modeData.valid, modeData.invalid, currentDaemon.height, deviance, statusDescription]);

    const response = JSON.stringify({haName: haName, modeHeight: modeHeight, daemonHeight: currentDaemon.height, deviance: deviance, status: statusDescription});

    res.writeHead(statusCode, {'Content-Type': 'text/html'});
    res.write(response);
    res.end();
}

/* Is the host specified present in the defined hosts in config */
function isValidhaName(haName) {
    return config.serviceNodes.findIndex(
        node => node.haName === haName
    ) !== -1;
}

function isValidMiningAddress(miningAddress) {
    return globals.networkPools.findIndex(
        pool => pool.miningAddress === miningAddress
    ) !== -1;
}

function launchServer() {
    const server = express();
    server.get('/hacheck', haCheckHandler);
    server.get('/hacheck/miningaddress/:miningAddress', haCheckHandler);
    server.get('/hacheck/:nodeGroup/:nodeId', haCheckHandler);
    server.get('/heights', heightsHandler);
    server.listen(config.serverPort);
}

function heightsHandler(req, res) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.write(JSON.stringify(globals.networkPools));
    res.end();
}

function updateServiceNodes(callback) {
    async.map(config.serviceNodes, getServiceNodeHeight, function(err, promises) {
        Promise.all(promises).then(results => {
            globals.serviceNodes = results
            log('info', logSystem, 'Updated service nodes. Success: %s, Fail: %s', [results.length, results.filter(val => val.error == true).length]);
            if (callback) {
                callback();
            }
        });
    });
}

function updateNetworkPools(callback) {
    const supportedPools = globals.networkPoolList.pools.filter(isSupportedPool)
    async.map(supportedPools, getPoolInfo, function(err, results) {

        const poolTotal = results.length;

        /* Filter null values (i.e. pools which failed to parse) */
        results = results.filter(val => val !== null);

        const poolFailed = (poolTotal - results.length);

        /* Get the mode height of all the pools now we've got all their data */
        const modeData = mode(results.map(x => x.height));
        const modeHeight = modeData.mode;

        /* Update the modeHeight of each entry with this new height */
        globals.networkPools = results.map(entry => {
            entry.mode = modeHeight;
            entry.status = (Math.abs(modeHeight - entry.height) <= config.serviceNodeMaxAlertDeviance) ? "UP" : "DOWN";
            return entry;
        });

        log('info', logSystem, 'Updated network pools. Success: %s , Fail: %s , Total: %s , Unsupported: %s , Mode: %s , Mode valid: %s , Mode invalid: %s', [poolTotal - poolFailed, poolFailed, globals.networkPoolList.pools.length, globals.networkPoolList.pools.length - supportedPools.length, modeHeight, modeData.valid, modeData.invalid]);

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
        timeout: config.networkPoolTimeout * 1000,
        strictSSL: false,
        encoding: null
    };

    request(options, function(error, response, body) {
        if (error !== null) {
            log('warn', logSystem, 'Failed request for %s, reason: %s', [url, error]);
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
            log('warn', logSystem, 'Failed request for %s, reason: %s', [url, e]);
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
            log('warn', logSystem, 'Failed to get pool info for: %s', [pool.api]);
            return callback(null, null);
        }

        /* Don't divide by zero */
        const estimatedSolveTime = json.pool.hashrate == 0 ? 'Never' : json.network.difficulty / json.pool.hashrate;

        const lastFound = json.pool.lastBlockFound == 0 ? 'Never' : json.pool.lastBlockFound;

        return callback(null, {
            name: pool.name,
            url: pool.url,
            api: pool.api,
            type: pool.type,
            miningAddress: pool.miningAddress,
            height: json.network.height,
            estimatedSolveTime: estimatedSolveTime,
            lastFound: lastFound,
            mode: undefined,
            status: undefined
        });
    });
}

function getNodeJSPoolInfo(pool, callback) {
    requestToJSON(pool.api + 'pool/stats', function(poolJSON) {
        if (poolJSON === undefined) {
            log('warn', logSystem, 'Failed to get pool info for: %s', [pool.api]);
            return callback(null, null);
        }
        requestToJSON(pool.api + 'network/stats', function(networkJSON) {
            if (networkJSON === undefined) {
                log('warn', logSystem, 'Failed to get pool info for: %s', [pool.api]);
                return callback(null, null);
            }
            return callback(null, {
                name: pool.name,
                url: pool.url,
                api: pool.api,
                type: pool.type,
                miningAddress: pool.miningAddress,
                height: networkJSON.height,
                estimatedSolveTime: networkJSON.difficulty / poolJSON.pool_statistics.hashRate,
                lastFound: secsSinceLastBlock(poolJSON.pool_statistics.lastBlockFound),
                mode: undefined,
                status: undefined
            });
        });
    });
}

function secsSinceLastBlock(timestamp) {
    /* This technically could be in the future... */
    const lastFound = new Date(timestamp * 1000);
    return (Date.now() - lastFound) / 1000;
}

function getServiceNodeHeight(serviceNode, callback) {
    const daemon = new TurtleCoind({
        host: serviceNode.node.host,
        port: serviceNode.node.port,
        timeout: config.serviceNodeTimeout * 1000
    });

    /* Get the height if we can */
    daemon.getHeight().then((node) => {
        return callback(null, {haName: serviceNode.haName, height: node.height, error: false});
    }).catch((err) => {        
        log('warn', logSystem, 'Failed to get height from %s %s:%s, reason: %s', [serviceNode.haName, serviceNode.node.host, serviceNode.node.port, err]);
        return callback(null, {haName: serviceNode.haName, height: 0, error: true});
    });
}

function updateNetworkPoolList(callback) {
    requestToJSON(config.poolListJSONurl, function(json) {
        if (json !== undefined) {
            globals.networkPoolList = json;
            log('info', logSystem, 'Updated network pool list. Count: %s', [globals.networkPoolList.pools.length]);
            if (callback) {callback(null);}
        } else {
            log('error', logSystem, 'Failed to update network pool list.', []);
            if (callback) {callback(true, null);}
        }
     });
}

/* Values are specified in milliseconds */
function backgroundTasks() {
    setInterval(updateNetworkPoolList, config.networkPoolListRefreshRate * 1000);
    setInterval(updateServiceNodes, config.serviceNodeRefreshRate * 1000);
    setInterval(updateNetworkPools, config.networkPoolRefreshRate * 1000);
}

function mode(arr) {
    var numMapping = {};
    var greatestFreq = 0;
    var mode = 0;
    var invalidCount = 0;

    arr.forEach(function findMode(number) {
        /* Skip zero heights */
        if (number === 0) {
            invalidCount += 1;
            return;
        }

        numMapping[number] = (numMapping[number] || 0) + 1;

        if (greatestFreq < numMapping[number]) {
            greatestFreq = numMapping[number];
            mode = number;
        }
    });

    return {mode: mode, valid: arr.length - invalidCount, invalid: invalidCount};
}
