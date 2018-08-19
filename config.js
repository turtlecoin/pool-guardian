var config = {};

/* A mapping of host headings to daemon IP's */
config.poolHostsToDaemons = [
    /* Of course these are just examples */
    {host: "a.com", daemon: {host: "us-west.turtlenode.io", port: "11898"}},
    {host: "b.com", daemon: {host: "us-east.turtlenode.io", port: "11898"}},
    {host: "c.com", daemon: {host: "europe.turtlenode.io", port: "11898"}},
    {host: "localhost:8080", daemon: {host: "127.0.0.1", port: "11898"}},
];

/* The port to run the server on */
config.serverPort = 8080;

/* The max amount of blocks a local daemon can be away from the median before
   reporting it has de-synced */
config.localDaemonMaxDeviance = 10;

/* The max amount of blocks a network daemon can be away from the median before
   reporting it has de-synced */
config.networkDaemonMaxDeviance = 10;

/* Seconds to wait for a response from a local daemon before giving up*/
config.localDaemonTimeout = 10;

/* Seconds to wait for a response from a network daemon before giving up*/
config.networkDaemonTimeout = 10;

/* How often should we poll our local pool daemons? (in seconds) */
config.localDaemonRefreshRate = 30;

/* How often should we poll the network daemons? (from the JSON url)
   (in seconds) */
config.networkDaemonRefreshRate = 30;

/* How often should we check the pool JSON for changes? (in seconds) */
config.poolJSONRefreshRate = 60 * 60;

/* The JSON link for the pools to compare our height to */
config.poolsJSON = "https://raw.githubusercontent.com/turtlecoin/turtlecoin-pools-json/master/v2/turtlecoin-pools.json";

module.exports = config;