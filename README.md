# pool-guardian

Provides an API to monitor cryptonote mining pools

## Prerequisites

* npm
* nodejs

## Fetching dependencies

`npm install`

## Running

`node init.js`

By default the server listens on 8080, but this can be changed in the config.

## Endpoints

* `/heights` - Lists the heights of all known pools
* `/hacheck` - Compares the pool daemon which maps to the passed in HOST header to the other pool daemons, and returns a 200 code if it is within 10 blocks of the mode height, of a 503 code if not. Designed to work with haproxy.

## Configuring

All configurable settings are available in config.js, and are all commented with what they do.

You probably want to be looking at config.poolHostsToDaemons initially, as this has some silly default values.

Remember to reload the code after changing any config settings.
