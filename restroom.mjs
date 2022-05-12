import fs from 'fs';
import path from 'path'
import readdirp from 'readdirp';
import express from "express";
import chalk from "chalk";
import bodyParser from "body-parser";
import zencode from "@restroom-mw/core";
import db from "@restroom-mw/db";
import fabric from "@restroom-mw/fabric";
import rrhttp from "@restroom-mw/http";
import rrredis from "@restroom-mw/redis";
import sawroom from "@restroom-mw/sawroom";
import timestamp from "@restroom-mw/timestamp";
import files from "@restroom-mw/files";
import ui from "@restroom-mw/ui";
import { zencode_exec } from "zenroom"

import http from "http";
import morgan from "morgan"
import dotenv from "dotenv";
import axios from 'axios';
import chokidar from 'chokidar';
import yaml from 'js-yaml';
import WebSocket from 'ws';

dotenv.config();
const MIN_PORT = 25000;
const MAX_PORT = 30000;
const zen = async (zencode, keys, data) => {
  const params = {};
  if (keys !== undefined && keys !== null) {
    params.keys = typeof keys === 'string' ? keys : JSON.stringify(keys);
  }
  if (data !== undefined && data !== null) {
    params.data = typeof data === 'string' ? data : JSON.stringify(data);
  }
  try {
    return await zencode_exec(zencode, params);
  } catch (e) {
    console.log("Error from zencode_exec: ", e);
  }
}

const intervalIDs = []

const startL1Cron = (path) => {
  // clean all intervals
  while(intervalIDs.length > 0) {
    clearInterval(intervalIDs.pop())
  }

  fs.readFile(path, (err, data) => {
    if(err) {
      console.error("Could not read L1 nodes");
      return;
    }
    //start the new ones as in the file
    data = yaml.load(data);
    console.log(`UPDATE_L1_LIST ${Date.now()}`)
    if(!data) {
      console.log("Could not read YAML")
      return;
    }

    Object.keys(data.ledgers).forEach( (key) => {
      const ledger = data.ledgers[key];
      const fnLogger = msg => console.log(`POLLING ${key} ${Date.now()} ${msg}`)
      if(ledger.interval > 0) {
        intervalIDs.push(setInterval(() => {
          axios
            .post(`http://127.0.0.1:${HTTP_PORT}/api/${ledger.contract}`)
            .then( res => {
              fnLogger(JSON.stringify(res.data))
            })
            .catch( err => {
              fnLogger(JSON.stringify(err))
            })
        }, ledger.interval * 1000))
      }
    })
  });


}

const startL1Watcher = () => {
  const file = path.join(FILES_DIR, L1NODES);
  //startL1Cron(file);
  chokidar.watch(file).on('all', (_, path) => {
    startL1Cron(path);
  });
}

const announce = (identity) => {
  const data = {
    "add-identity": "https://apiroom.net/api/dyneorg/zenswarm-server-add-identity",
    "post": {
      "data": {
        "identity": identity
      }
    }
  }

  axios
    .post(`http://127.0.0.1:${HTTP_PORT}/api/consensusroom-announce`, {"data": data})
    .then( res => {
      console.log(JSON.stringify(res.data))
      //startL1Watcher();
      subscribeEth();
      subscribeSaw();
    })
    .catch( e => {
      console.log(e)
      console.error("Error in announce contract");
      process.exit(-1);
    })
};

const saveVMLetStatus = async () => {
  // generate private keys
  const generatePrivateKeysScript = fs.readFileSync(path.join(PRIVATE_ZENCODE_DIR,
                  "consensus-generate-all-private-keys.zen"), 'utf8')

  const keys = await zen(generatePrivateKeysScript, null, null);
  if(!keys) {
    process.exit(-1)
  }
  fs.writeFileSync(
    path.join(ZENCODE_DIR, "consensusroom-generate-all-public-keys.keys"),
    keys.result)
  fs.writeFileSync(
    path.join(ZENCODE_DIR, "keyring.json"),
    keys.result)

  // generate relative public keys
  axios
    .get(`http://127.0.0.1:${HTTP_PORT}/api/consensusroom-generate-all-public-keys`)
    .then( res => {
      // put all togheter in the identity
      const identity = {
        "uid":`${HOST}:${HTTP_PORT}`,
        "ip":HOST,
        "baseUrl":`http://${HOST}`,
        "port_http":`${HTTP_PORT}`,
        "port_https":`${HTTPS_PORT}`,
        "version":"2",
        "announceAPI":"/api/consensusroom-announce",
        "get-6-timestampsAPI":"/api/consensusroom-get-6-timestamps",
        "timestampAPI":"/api/consensusroom-get-timestamp",
        "updateAPI":"/api/consensusroom-update",
        "http-postAPI": "/api/consensusroom-http-post",
        "pingAPI" : "/api/consensusroom-ping",
        "http-postAPI" : "/api/consensusroom-http-post",
        "oracle-key-issuance": "/api/zenswarm-oracle-key-issuance.chain",
        "tracker":"https://apiroom.net/",
        "type": "restroom-mw",
        "region": REGION,
        "country": `${COUNTRY}`
      }
      Object.assign(identity, res.data)
      fs.writeFileSync(
        path.join(ZENCODE_DIR, "identity.keys"),
        JSON.stringify({"identity": identity}))

      announce(identity)
    })
    .catch(e => {
      console.error("Error in generate public key contract");
      process.exit(-1);
    })

}
function between(min, max) {
  return Math.floor(
    Math.random() * (max - min) + min
  )
}

function startHttp(initial_port, callback) {
  let port = initial_port;
  const httpServer = http.createServer(app);
  let retry = 1000;
  if(port <= 0) port = between(MIN_PORT, MAX_PORT);
  console.log(`CHOSEN_HTTP_PORT ${port}`)
  httpServer.listen(port, function() {
    console.log(`LISTENING ${httpServer.address().port}`);
    callback();
  }).on('error', function(err) {
    console.log(`ERROR ${err.code}`)
    if(err.code == 'EADDRINUSE') {
      port = between(MIN_PORT, MAX_PORT);
      console.log(`CHOSEN_HTTP_PORT ${port}`)
      if(retry-- > 0)
        httpServer.listen(port);
      else
        throw new Error("Could not find a free port")
    } else {
      console.log(err);
      process.exit(-1);
    }
  });
  return port
}

let HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 0;
let HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 0;
const HOST = process.env.HOST || "0.0.0.0";
const COUNTRY = process.env.COUNTRY || "NONE";
const ZENCODE_DIR = process.env.ZENCODE_DIR;
const PRIVATE_ZENCODE_DIR = process.env.PRIVATE_ZENCODE_DIR;
const OPENAPI = JSON.parse(process.env.OPENAPI || true);
const L1NODES = process.env.L1NODES || "L1.yaml";
const FILES_DIR = process.env.FILES_DIR || "contracts";
const REGION = process.env.REGION || "NONE";
const WS_ETH = process.env.WS_ETH || "ws://78.47.38.223:8546"
const HTTP_ETH = process.env.HTTP_ETH || "http://78.47.38.223:8545"
const WS_SAW = process.env.WS_SAW || "ws://195.201.41.35:8008/subscriptions"
const HTTP_SAW = process.env.HTTP_SAW || "http://195.201.41.35:8008/"


const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(morgan("dev"));
app.set("json spaces", 2);

app.use(db.default);
app.use(fabric.default);
app.use(rrhttp.default);
app.use(rrredis.default);
app.use(sawroom.default);
app.use(timestamp.default);
app.use(files.default);
if (OPENAPI) {
  app.use("/docs", ui.default({ path: ZENCODE_DIR }));
}

app.use("/api/*", zencode.default);

if(!fs.existsSync(ZENCODE_DIR)) {
  fs.mkdirSync(ZENCODE_DIR, { recursive: true });
}
const contracts = fs.readdirSync(ZENCODE_DIR);

if (contracts.length > 0) {
  const httpStarted = async () => {
    process.env.HTTPS_PORT = HTTPS_PORT;
    await saveVMLetStatus();
    console.log(`🚻 Restroom started on http://${chalk.bold.blue(HOST)}:${HTTP_PORT} and http://${chalk.bold.blue(HOST)}:${HTTPS_PORT}`);
    console.log(`📁 the ZENCODE directory is: ${chalk.magenta.underline(ZENCODE_DIR)} \n`);

    if (OPENAPI) {
      console.log(`To see the OpenApi interface head your browser to: ${chalk.bold.blue.underline('http://' + HOST + ':' + HTTP_PORT + '/docs')}`);
      console.log(`To disable OpenApi, run ${chalk.bold('OPENAPI=0 yarn start')}`);
    } else {
      console.log(`⚠️ The OpenApi is not enabled! NO UI IS SERVED. To enable it run run ${chalk.bold('OPENAPI=1 yarn start')}`);
    }

    console.log("\nExposing");
    readdirp(ZENCODE_DIR, { fileFilter: '*.zen|*.yaml|*.yml' }).on('data', (c) => {
      const endpoint = `/api/${c.path.replace('.zen', '')}`
      console.log(`\t${chalk.bold.green(endpoint)}`);
    });
  }
  HTTP_PORT = startHttp(HTTP_PORT, () => {
    process.env.HTTP_PORT = HTTP_PORT;
    HTTPS_PORT = startHttp(HTTPS_PORT, httpStarted);
  });

} else {
  console.log(`🚨 The ${chalk.magenta.underline(ZENCODE_DIR)} folder is empty, please add some ZENCODE smart contract before running Restroom`);
}

function subscribeEth() {
  try {
    const ws = new WebSocket(WS_ETH);
    ws.onopen = function() {
      const id = Math.floor(Math.random() * 65536);
      let subscriptionId = null;
      ws.send(JSON.stringify({
        id,
        jsonrpc:"2.0",
        method: "eth_subscribe",
        params: ["newHeads"]
      }));
      const processMsg = function(event) {
        let msg = JSON.parse(event.data)
        if(msg.method == "eth_subscription"
           && msg.params && msg.params.subscription == subscriptionId) {
          const block = msg.params.result;
          msg['endpoint'] = HTTP_ETH;
          console.log("ETH_NEW_HEAD " + block.hash);
          axios.post('https://apiroom.net/api/dyneebsi/ethereum-notarization.chain',
            {data: msg}).then(function(data) {
              console.warn(data.data);
            });
        }
      }
      ws.onmessage = function(e) {
        const msg = JSON.parse(e.data);
        if(msg.result && msg.id == id) {
          subscriptionId = msg.result
          // from now on messages will be processed as blocks
          ws.onmessage = processMsg;
        }

      }
    }
  } catch(e) {
    console.log("COuld not start eth web socket");
    console.log(e)
    process.exit(-1);
  }
}


function subscribeSaw() {
  try {
    const ws = new WebSocket(WS_SAW);
    ws.onopen = function() {
      ws.send(JSON.stringify({
        action: "subscribe"
      }));
      ws.onmessage = function(event) {
        try {
          let msg = JSON.parse(event.data)
          const block = msg.block_id;
          msg['endpoint'] = HTTP_SAW;
          console.log("SAW_NEW_HEAD " + block);
          //console.log(msg)
          /*axios.post('https://apiroom.net/api/dyneebsi/sawroom-notarization.chain', {data: msg})
            .then(function(data) {
              console.log(data);
            })*/
        } catch(e) {
          console.warn(`WS SAW ERROR: ${e}`)
        }
      }
    }
  } catch(e) {
    console.log("COuld not start eth web socket");
    console.log(e)
    process.exit(-1);
  }
}
