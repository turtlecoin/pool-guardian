var http = require('http');
var express = require('express');
var async = require('async');
var request = require('request');
const TurtleCoind = require('turtlecoin-rpc').TurtleCoind;

var logSystem = 'turtlecoind-haCheck'
require('./exceptionWriter.js')(logSystem)

var log = function (severity, system, text, data) {
  global.log(severity, system, text, data)
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
    /* Make sure the host header is present in the defined hosts in config */

    if (!isValidHost(req.headers.host)) {
        log('info', logSystem, 'Request for host: %s , is invalid', [req.headers.host])
        res.writeHead(400, {'Content-Type': 'text/html'})
        res.write(`Specified host (${req.headers.host}) is not present in config!`)
        res.end();
        return;
    }

    /* Get mode height and compare to the rest of the pools */
    var modeHeight = mode(globals.networkDaemons.map(x => x.height));

    /* The host making the requests info */
    var currentDaemon = globals.localDaemons.find(x => x.host === req.headers.host);

    var deviance = Math.abs(modeHeight - currentDaemon.height)
    var status = deviance <= config.localDaemonMaxDeviance
    var statusDescription = (status) ? "pass" : "fail"
    
    log('info', logSystem, 'Request for host: %s , Mode height: %s , Daemon Height: %s , Deviance: %s , Status: %s', [req.headers.host, modeHeight, currentDaemon.height, deviance, statusDescription]);

    var response = JSON.stringify({host: req.headers.host, modeHeight: modeHeight, daemonHeight: currentDaemon.height, deviance: deviance, status: statusDescription})

    /* Is it too much above or below the mode value */
    if (status) {
        res.writeHead(200, {'Content-Type': 'text/html'})
        res.write(response)
        res.end();
    } else {
        res.writeHead(503, {'Content-Type': 'text/html'})
        res.write(response)
        res.end()
    }
}

/* Is the host specified present in the defined hosts in config */
function isValidHost(host) {
    return config.poolHostsToDaemons.findIndex(
        pool => pool.host === host
    ) !== -1;
}

function launchServer() {
    var server = express();

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
        });

        if (callback) {
            callback();
        }
    });
}

function getNetworkDaemonStatus(callback) {
    async.map(globals.networkPools.pools.filter(supportedPool), getPoolInfo, function(err, results) {
        /* Filter null values (i.e. pools which failed to parse) */
        results = results.filter(val => val !== null);

        /* Get the mode height of all the pools now we've got all their data */
        var modeHeight = mode(results.map(x => x.height));

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

function getForknotePoolInfo(pool, callback) {
    request({
        url: pool.api + 'stats',
        timeout: config.networkDaemonTimeout * 1000
    }, function(error, response, body) {

        /* Annoyingly, if we return an error in the callback it will stop
           the processing completely. This is obviously not desired, so we
           can hack around it by returning (null, null), then filtering null
           values. */
        if (error !== null) {           
            log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [pool.api, error]);
            return callback(null, null);
        }

        try {
            var json = JSON.parse(body);

            /* Don't divide by zero */
            var estimatedSolveTime = json.pool.hashrate == 0 ? 'Never'
                                   : json.network.difficulty / json.pool.hashrate;

            var lastFound = json.pool.lastBlockFound == 0 ? 'Never'
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
        } catch (e) {            
            log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [pool.api, e]);
            return callback(null, null);
        }
    });
}

function getNodeJSPoolInfo(pool, callback) {
    request(pool.api + 'pool/stats', function(error, response, poolBody) {
        request(pool.api + 'network/stats', function(error2, response2, networkBody) {
            if (error !== null || error2 !== null) {                
                log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [pool.api, error !== null ? error : error2]);
                return callback(null, null);
            }

            try {
                var poolJSON = JSON.parse(poolBody);
                var networkJSON = JSON.parse(networkBody);

                return callback(null, {
                    url: pool.url,
                    height: networkJSON.height,
                    estimatedSolveTime: networkJSON.difficulty / poolJSON.pool_statistics.hashRate,
                    lastFound: secsSinceLastBlock(poolJSON.pool_statistics.lastBlockFound),
                    mode: undefined,
                });
            } catch (e) {                
                log('info', logSystem, 'Failed to get pool info from %s, reason: %s', [pool.api, e]);
                return callback(null, null);
            }
        });
    });
}

function secsSinceLastBlock(timestamp) {
    /* This technically could be in the future... */
    var lastFound = new Date(timestamp * 1000);

    var now = Date.now();

    return (now - lastFound) / 1000;
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
    request(config.poolsJSON, function(error, response, body) {
        globals.networkPools = JSON.parse(body);
        
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
