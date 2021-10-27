import { createRequire } from 'module'
import { TezosToolkit } from '@taquito/taquito'
import { InMemorySigner } from '@taquito/signer'

import queue from './queue.mjs'
import NftHandler from './operations/nft.mjs'
import TezHandler from './operations/tez.mjs'

const require = createRequire(import.meta.url);
require('console-stamp')(console);
const config = require('./config.json');

const main = async function() {
	try{
		const tezos = new TezosToolkit(config.rpcUrl);
		const signer = new InMemorySigner(config.privateKey);
		const address = await signer.publicKeyHash();
		tezos.setSignerProvider(signer);

		const handlers = {
			'nft': NftHandler(tezos, config.nftContract),
			'tez': TezHandler(tezos)
		}

		const dispatch_command = function(command, batch) {
			let handler = handlers[command.handler];
			if (handler) {
				let handling_function = handler[command.name];
				if (handling_function) {
					return handling_function(command.args, batch);
				}
			}
			console.warn("Invalid comand:", JSON.stringify(command));
			return false;
		}

		const heartbeat = async function() {
			let ops = await queue.checkout(originator = address, limit = config.batchSize);
			if (ops.length = 0) {
				console.log("No pending operations for originator", address);
				return true;
			}

			console.log("Generating batch with", ops.length, "operations.")
			let batch = tezos.wallet.batch();
			let batched_ids = [];
			let rejected_ids = [];
			ops.forEach((operation) => {
				let success = dispatch_command(operation.command, batch);
				if (success) {
					batched_ids.push(operation.id);
				} else {
					rejected_ids.push(operation.id);
				}
			});

			if (rejected_ids.length > 0) {
				console.warn('Rejected operations with ids:', JSON.stringify(rejected_ids));
				queue.save_rejected(rejected_ids).catch((err) => { console.error("Database error when updating rejected operation with ids:", JSON.stringify(rejected_ids)); });;
			}
			console.log("Attempting to send operation group containing operations with ids:", JSON.stringify(batched_ids));
			try {
				let sent_operation = await batch.send();
				let op_hash = sent_operation.opHash;
				console.log("Sent operation group with hash", op_hash, "containing operations with ids:", JSON.stringify(batched_ids));
				queue.save_sent(batched_ids, sent_operation.opHash).catch((err) => { console.error("Database error when writing hash to operations with ids:", JSON.stringify(batched_ids)); });
				let result = await sent_operation.confirmation(config.confirmations);
				if (result.completed) {
					console.log("Operation group with hash", op_hash, "has been successfully confirmed.");
					queue.save_confirmed(batched_ids).catch((err) => { console.error("Database error when saving confirmed status to operations with ids:", JSON.stringify(batched_ids)); });
					return true;
				} else {
					console.log("Operation group with hash", op_hash, "has failed.")
					queue.save_failed(batched_ids).catch((err) => { console.error("Database error when saving failed status to operations with ids:", JSON.stringify(batched_ids)); });
				}
			} catch (err) {
				console.error("An error has occurred when processing operations with ids:", JSON.stringify(batched_ids), "\n", err);
			}
			return false;
		};

		let signal = true;
		while (signal) {
			try {
				let finished = heartbeat()
				let [ result, _ ] = await Promise.all([
					heartbeat(),
					new Promise(_ => setTimeout(_, config.pollingDelay))
				]);
				signal = result;
			} catch (err) {
				console.error("An error has occurred in the main event loop.\n", err);
				signal = false;
			}
		}
	} catch (err) {
		console.log("An error has ocurred outside the main event loop.\n", err);
	}

};

main();