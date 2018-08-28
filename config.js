var config = {};

/* A mapping of host headings to daemon IP's */
config.serviceNodes = [
    /* Of course these are just examples */
    {haName: "nodes/node-a", node: {host: "127.0.0.1", port: "12898"}},
    {haName: "nodes/node-b", node: {host: "127.0.0.1", port: "13898"}},
];

/* The port to run the server on */
config.serverPort = 8080;

/* The max amount of blocks a service node can be away from the median before
   reporting it has de-synced. This is used with x-haproxy-server-state header
   to control the HAProxy failover point.
   This value is used only if a deviance is not present in the URL
*/
config.serviceNodeMaxFailoverDeviance = 10;

/* The max amount of blocks a service node can be away from the median before
   reporting it has de-synced. This is used with url queries for services like
   uptime robot, pingdom, monitority.
   This value is only used if a deviance is not present in the URL
*/
config.serviceNodeMaxAlertDeviance = 5;

/* The max amount of blocks a network daemon can be away from the median before
   reporting it has de-synced
config.networkDaemonMaxDeviance = 10;
*/

/* Seconds to wait for a response from a service node before giving up*/
config.serviceNodeTimeout = 10;

/* Seconds to wait for a response from a network daemon before giving up*/
config.networkPoolTimeout = 10;

/* How often should we poll our service nodes? (in seconds) */
config.serviceNodeRefreshRate = 30;

/* How often should we poll the network daemons? (from the JSON url)
   (in seconds) */
config.networkPoolRefreshRate = 30;

/* How often should we check the pool JSON for changes? (in seconds) */
config.networkPoolListRefreshRate = 3600;

/* Heights within this number of each other will count as the same when
   calculating the overall mode height consenus of the network
*/
config.modeFuzzing = 2;

/* The percentage of valid network nodes that must be in consensus to be
   considered reliable enough to compare against service daemons or pools to
   determine their state
*/
config.minActionableModeConsensusPercent = 50;

/* The amount of time when the network is in a state of non-consensus to
   fail a daemon or pool that has not changed in height. A downed/non-responding daemon
   will always fail, as will a syncing daemon or one that reports a 0 height
*/
config.minActionableNonConsensusSeconds = 300;

/* The JSON link for the pools to compare our height to */
config.poolListJSONurl = "https://raw.githubusercontent.com/turtlecoin/turtlecoin-pools-json/master/v2/turtlecoin-pools.json";

config.logging = {
  "files": {
      "level": "info",
      "directory": "logs",
      "flushInterval": 5
  },
  "console": {
      "level": "info",
      "colors": true
  }
}

module.exports = config;
