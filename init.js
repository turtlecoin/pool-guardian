var fs = require('fs');
var cluster = require('cluster');
var os = require('os');

global.config = require('./config');

require('./logger.js');

var logSystem = 'master';
require('./exceptionWriter.js')(logSystem);


if (cluster.isWorker){
    switch(process.env.workerType){
        case 'turtlecoind-haCheck':
            require('./turtlecoind-haCheck.js')
            break;
    }
    return;
}


(function init() {
  spawnWorker()
})();


function spawnWorker() {

  var worker = cluster.fork({
    workerType: 'turtlecoind-haCheck'
  });
  worker.on('exit', function (code, signal) {
    log('error', logSystem, 'turtlecoind-haCheck died, spawning replacement...');
    setTimeout(function () {
      spawnWorker();
    }, 2000);
  });

}