# pool-guardian

Provides an API to monitor cryptonote mining pools
Designed to work with HAProxy to provide high availabilty and smart daemon failover.
Can also be used just for monitoring and alerts with uptime robot, monitority, pingdom, etc.. (HAProxy is not required)

## Prerequisites

* npm
* nodejs

## Setup

```
git clone https://github.com/turtlecoin/pool-guardian.git
cd pool-guardian
npm install
```

* The app can be launched with `node init.js`

By default the server listens on 8080, but this can be changed in the config.js

## Endpoints

* `/heights` - Lists the heights of all known pools
* `/hacheck` - Compares the daemon passed in x-haproxy-server-state header to other network pools, and returns a 200 code if it is within 10 blocks of the mode height, or a 503 code if not. Designed to work with haproxy.
* `/hacheck/<nodeGroup>/<nodeId>` - Compares the daemon passed in url to other network pools, and returns a 200 code if it is within 5 blocks of the mode height, of a 503 code if not. Designed for monitoring services (uptime robot, monitority, pingdom, etc..)
* `/hacheck/miningaddress/<poolMiningAddress>` - Compares the pool mining address passed in url to other network pools, and returns a 200 code if it is within 5 blocks of the mode height, of a 503 code if not. Designed for monitoring services (uptime robot, monitority, pingdom, etc..)

Notes:
* `/hacheck/<nodeGroup>/<nodeId>` queries for a specific daemon, and `/hacheck/miningaddress/<poolMiningAddress>` queries the pool directly, and in effect whatever daemon is currently active on it, additionally this is also testing if your pool API is responisve.
* All endpoints accept an additional parameter `/<failureDeviance>` which is an integer, and overrides the default failure deviance from the config.js file. For example, `/heights/10` or `/hacheck/<nodeGroup>/<nodeId>/15`

## Configuring

All configurable settings are available in config.js, and are all commented with what they do.

You probably want to be looking at config.serviceNodes initially.

### Example Configuration based on Ubuntu 16.04 for simple single daemon (and/or pool) monitoring with alerts

(This configuration assumes both this app and the daemon are running on the same host, and the daemon is running using the default rpc port 11898)

Install this app:

```
git clone https://github.com/turtlecoin/pool-guardian.git
cd pool-guardian
npm i
```

Edit `config.js` and change `config.serviceNodes` to:

```
config.serviceNodes = [
    {haName: "nodes/node-a", node: {host: "127.0.0.1", port: "11898"}}
];
```

This is all that is necessary, however a few additional steps can make things easier.

Add a dns entry for this server with your dns provider, for example: trtl-check.yourpool.com

Update Nginx to proxy trtl-check.yourpool.com to the default 8080 port of this app:

(If you choose not to do this, open port 8080 in your firewall so that this app can be reached by monitoring services, and your montoring will be reached at http://www.yourpool.com:8080/)

Edit the Nginx config:

`nano /etc/nginx/sites-available/default`

At the bottom add (replace trtl-check.yourpool.com with what you used for your dns entry):

```
server {
  charset utf-8;
  listen 80;
  listen [::]:80;
  server_name trtl-check.yourpool.com;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

  location / {
    proxy_pass http://127.0.0.1:8080;
  }
}
```

Restart Nginx:

`sudo systemctl restart nginx`

Start this app:

`node init.js`

Your daemon and/or pool can now me monitored by url monitoring services, for example http://www.uptimedoctor.com:

The url's to monitor are:

```
daemon: http://trtl-check.yourpool.com/hacheck/nodes/node-a
pool: http://trtl-check.yourpool.com/hacheck/miningaddress/<your_mining_address>
```

you may also choose to monitor at differnent deviances, for example if your pool or daemon is only 5 blocks ahead or behind, receive an alert:

```
daemon: http://trtl-check.yourpool.com/hacheck/nodes/node-a/5
pool: http://trtl-check.yourpool.com/hacheck/miningaddress/<your_mining_address>/5
```

(note: The mining address must exactly match your mining address from here: https://raw.githubusercontent.com/turtlecoin/turtlecoin-pools-json/master/v2/turtlecoin-pools.json)


### Example Configuration based on Ubuntu 16.04 for multi-daemon proxy with failover

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

* At the bottom of haproxy.cfg add:

Notes:

* This configuration assumes you have 2 daemons running on local host at ports 12898 and 13898, and this app is reachable at trtl-check.yourpool.com:8080, and your proxied high availablity daemons will be reached on port 11898.

* Note below that 'nodes' and 'node-a' and 'node-b' correspond to entries in default config.js, config.serviceNodes variable as nodes/node-a and nodes/node-b and are passed to the app by HAProxy to identify these daemons.

```
listen nodes
    bind *:11898
    option forwardfor
    option httpchk GET /hacheck "HTTP/1.0\r\nHost: trtl-check.yourpool.com"
    http-check send-state
    server node-a 127.0.0.1:12898 check port 8080 inter 15s fall 40 rise 2
    server node-b 127.0.0.1:13898 check backup port 8080 inter 15s fall 40 rise 2
```

`inter 15s fall 40 rise 2` will check the daemons every 15 seconds and mark it as down after 40 failures (10 minutes) and mark it as up after 2 successful checks.

Check the HAProxy manual for advanced configuration options: https://cbonte.github.io/haproxy-dconv/1.7/configuration.html

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
