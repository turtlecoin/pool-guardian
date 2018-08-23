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
* `/hacheck` - Compares the daemons which maps to the passed in x-haproxy-server-state header or haName query to the other network pool daemons, and returns a 200 code if it is within 10 blocks of the mode height, of a 503 code if not. Designed to work with haproxy.

## Configuring

All configurable settings are available in config.js, and are all commented with what they do.

You probably want to be looking at config.serviceNodes initially.

Example Configuration based on Ubuntu 16.04.

* Install HAProxy:

```
sudo apt-get -y install haproxy
```

* Test HAProxy installation:

```
haproxy -v
```

The server will respond with:
```
HA-Proxy version 1.6.3 2015/12/25
Copyright 2000-2015 Willy Tarreau <willy@haproxy.org>
```

* Edit HAProxy config:

```
nano /etc/haproxy/haproxy.cfg
```

* At the bottom of haproxy.cfg add (This configuration assumes you have 2 daemons running on local host at ports 12898 and 13898, and this app is reachable at hacheck.yoursite.com:8080):

```
listen nodes
    bind *:11898
    option forwardfor
    option httpchk GET /hacheck "HTTP/1.0\r\nHost: hacheck.yoursite.com"
    http-check send-state
    server node-a 127.0.0.1:13898 check port 8080 inter 15s fall 40 rise 2
    server node-b 127.0.0.1:12898 check backup port 8080 inter 15s fall 40 rise 2
```

* Test HAProxy config:

```
haproxy -f /etc/haproxy/haproxy.cfg -c
```

* Restart HAProxy:

```
sudo service haproxy restart
```

* Start this app:

```
node init.js
```
