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

    const requestIP = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip;
    const dateNowSeconds = Date.now() / 1000 | 0;

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
        log('warn', logSystem, 'Request is missing x-haproxy-server-state header or params', []);
        res.writeHead(400, {'Content-Type': 'text/html'});
        res.write(`Request is missing x-haproxy-server-state header or params`);
        res.end();
        return;
    }

    /* Make sure the x-haproxy-server-state header is present and is a defined haName in the config or we have a valid miningAddress */
    if (!isMiningAddress && (!isValidhaName(haName)) || (isMiningAddress && (!isValidMiningAddress(haName)))) {
        log('info', logSystem, 'Request for haName: %s, is invalid', [haName]);
        res.writeHead(400, {'Content-Type': 'text/html'});
        res.write(`Specified name (${haName}) is not valid!`);
        res.end();
        return;
    }

    /* Get mode height and compare to requested daemon or pool */
    const modeData = mode(globals.networkPools.map(x => x.height));
    const modeHeight = modeData.mode;
    const currentDaemon = isMiningAddress ? globals.networkPools.find(x => x.miningAddress === haName) : globals.serviceNodes.find(x => x.haName === haName);
    const failureDeviance = (req.params.deviance !== undefined) ? parseInt(req.params.deviance) : (isFailoverCheck) ? config.serviceNodeMaxFailoverDeviance : config.serviceNodeMaxAlertDeviance;
    const deviance = Math.abs(modeHeight - currentDaemon.height);

    var status;

    if (modeData.consensus >= config.minActionableModeConsensusPercent) {
        status = deviance <= failureDeviance;
    } else if (currentDaemon.height == 0 || dateNowSeconds - currentDaemon.lastChange > config.minActionableNonConsensusSeconds) {
        status = false;
    } else {
        status = true;
    }

    const statusDescription = (status) ? "UP" : "DOWN";
    const statusCode = (status) ? 200 : 503;

    log('info', logSystem, 'Request for haName: %s , Status: %s , Mode height: %s , Mode valid: %s , Mode invalid: %s , Mode Consensus: %s\% , Daemon Height: %s , Deviance: %s , Failure deviance: %s , Last Change: %s , Last update: %s , Request IP: %s',
        [haName, statusDescription, modeHeight, modeData.valid, modeData.invalid, modeData.consensus, currentDaemon.height, deviance, failureDeviance, dateNowSeconds - currentDaemon.lastChange, dateNowSeconds - currentDaemon.updated, requestIP]);

    const response = JSON.stringify({
        haName: haName,
        status: statusDescription,
        modeHeight: modeHeight,
        modeValid: modeData.valid,
        modeInvalid: modeData.invalid,
        modeConsensus: modeData.consensus,
        daemonHeight: currentDaemon.height,
        deviance: deviance,
        failureDeviance: failureDeviance,
        lastChange: dateNowSeconds - currentDaemon.lastChange,
        updated: dateNowSeconds - currentDaemon.updated,
        requestIP: requestIP
    });

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
    server.get('/hacheck/:deviance([0-9]+)', haCheckHandler);
    server.get('/hacheck/miningaddress/:miningAddress', haCheckHandler);
    server.get('/hacheck/miningaddress/:miningAddress/:deviance([0-9]+)', haCheckHandler);
    server.get('/hacheck/:nodeGroup/:nodeId', haCheckHandler);
    server.get('/hacheck/:nodeGroup/:nodeId/:deviance([0-9]+)', haCheckHandler);
    server.get('/heights', heightsHandler);
    server.get('/heights/:deviance([0-9]+)', heightsHandler);
    server.listen(config.serverPort);
}

function heightsHandler(req, res) {

    const requestIP = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip;
    const dateNowSeconds = Date.now() / 1000 | 0;
    const modeData = mode(globals.networkPools.map(x => x.height));
    const failureDeviance = (req.params.deviance !== undefined) ? parseInt(req.params.deviance) : config.serviceNodeMaxAlertDeviance;

    const networkPools = JSON.parse(JSON.stringify(globals.networkPools)).map(entry => {

        if (modeData.consensus >= config.minActionableModeConsensusPercent) {
            entry.status = (Math.abs(entry.mode - entry.height) <= failureDeviance) ? "UP" : "DOWN";
        } else if (entry.height == 0 || dateNowSeconds - entry.lastChange > config.minActionableNonConsensusSeconds) {
            entry.status = "DOWN";
        } else {
            entry.status = "UP";
        }
        return entry;
    });

    const failedCount =  networkPools.filter(val => val.status == "DOWN").length
    log('info', logSystem, 'Request for /heights Total: %s , Up: %s , Down: %s , Failure Deviance: %s , Mode height: %s , Mode valid: %s , Mode invalid: %s , Mode Consensus: %s\% , Request IP: %s',
        [networkPools.length, networkPools.length - failedCount, failedCount, failureDeviance, modeData.mode, modeData.valid, modeData.invalid, modeData.consensus, requestIP]);

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.write(JSON.stringify(networkPools));
    res.end();
}

function updateServiceNodes(callback) {
    async.map(config.serviceNodes, getServiceNodeHeight, function(err, promises) {
        Promise.all(promises).then(results => {
            globals.serviceNodes = results.map(entry => {
                var index = (globals.serviceNodes !== undefined) ? globals.serviceNodes.findIndex(node => node.haName === entry.haName) : -1;
                if (index != -1 && entry.height == globals.serviceNodes[index].height) {
                     entry.lastChange = globals.serviceNodes[index].lastChange;
                }

                return entry;
            });

            const failedCount =  results.filter(val => val.error == true).length
            log('info', logSystem, 'Updated service nodes. Total: %s , Success: %s , Fail: %s', [results.length, results.length - failedCount, failedCount]);
            if (callback) {
                callback();
            }
        });
    });
}

function updateNetworkPools(callback) {
    const supportedPools = globals.networkPoolList.pools.filter(isSupportedPool)
    async.map(supportedPools, getPoolInfo, function(err, results) {

        const dateNowSeconds = Date.now() / 1000 | 0;
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
            var index = (globals.networkPools !== undefined) ? globals.networkPools.findIndex(pool => pool.name === entry.name) : -1;
            if (index != -1 && entry.height == globals.networkPools[index].height) {
                 entry.lastChange = globals.networkPools[index].lastChange;
            }

            return entry;
        });

        log('info', logSystem, 'Updated network pools. Success: %s , Fail: %s , Total: %s , Unsupported: %s , Mode: %s , Mode valid: %s , Mode invalid: %s , Mode Consensus: %s\%', [poolTotal - poolFailed, poolFailed, globals.networkPoolList.pools.length, globals.networkPoolList.pools.length - supportedPools.length, modeHeight, modeData.valid, modeData.invalid, modeData.consensus]);

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

        const dateNowSeconds = Date.now() / 1000 | 0;

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
            status: undefined,
            lastChange: dateNowSeconds,
            updated: dateNowSeconds
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

            const dateNowSeconds = Date.now() / 1000 | 0;

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
                status: undefined,
                lastChange: dateNowSeconds,
                updated: dateNowSeconds
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

    const dateNowSeconds = Date.now() / 1000 | 0;

    /* Get the height if we can */
    daemon.getHeight().then((node) => {
        return callback(null, {haName: serviceNode.haName, height: node.height, lastChange: dateNowSeconds, updated: dateNowSeconds, error: false});
    }).catch((err) => {        
        log('warn', logSystem, 'Failed to get height from %s %s:%s, reason: %s', [serviceNode.haName, serviceNode.node.host, serviceNode.node.port, err]);
        return callback(null, {haName: serviceNode.haName, height: 0, lastChange: dateNowSeconds, updated: dateNowSeconds, error: true});
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

    const arrValid = arr.filter(val => val != 0)

    arrValid.forEach(function findMode(number) {
        for(var i = number - config.modeFuzzing; i <= number + config.modeFuzzing; i++) {
            numMapping[i] = (numMapping[i] || 0) + 1;

            if (greatestFreq < numMapping[i]) {
                greatestFreq = numMapping[i];
                mode = i;
            }
        }
    });

    const invalidCount = arr.length - arrValid.length
    const validCount = arrValid.length;
    const consensusPercent = (Math.round((greatestFreq / validCount * 100) * 100) / 100).toFixed(2);
    return {mode: mode, total: arr.length, valid: validCount, invalid: invalidCount, consensus: consensusPercent};
}
