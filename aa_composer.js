/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var constants = require('./constants.js');
var storage = require('./storage.js');
var db = require('./db.js');
var ValidationUtils = require("./validation_utils.js");
var objectLength = require("./object_length.js");
var objectHash = require("./object_hash.js");
var aa_validation = require("./aa_validation.js");
var validation = require("./validation.js");
var formulaParser = process.browser ? null : require('./formula/index'+'');
var kvstore = require('./kvstore.js');
var eventBus = require('./event_bus.js');
var mutex = require('./mutex.js');
var writer = require('./writer.js');

var isNonnegativeInteger = ValidationUtils.isNonnegativeInteger;
var isNonemptyArray = ValidationUtils.isNonemptyArray;
var isNonemptyObject = ValidationUtils.isNonemptyObject;

var TRANSFER_INPUT_SIZE = 0 // type: "transfer" omitted
	+ 44 // unit
	+ 8 // message_index
	+ 8; // output_index

var OUTPUT_SIZE = 32 + 8; // address + amount

eventBus.on('new_aa_triggers', function () {
	mutex.lock(["write"], function (unlock) {
		unlock(); // we don't need to block writes, we requested the lock just to wait that the current write completes
		handleAATriggers();
	});
});

function handleAATriggers() {
	mutex.lock(['aa_triggers'], function (unlock) {
		db.query(
			"SELECT aa_triggers.mci, aa_triggers.unit, address, definition \n\
			FROM aa_triggers CROSS JOIN aa_addresses USING(address) \n\
			ORDER BY aa_triggers.mci, aa_triggers.unit, address",
			function (rows) {
				var arrPostedUnits = [];
				async.eachSeries(
					rows,
					function (row, cb) {
						var arrDefinition = JSON.parse(row.definition);
						handlePrimaryAATrigger(row.mci, row.unit, row.address, arrDefinition, arrPostedUnits, cb);
					},
					function () {
						arrPostedUnits.forEach(function (unit) {
							eventBus.emit('new_aa_unit', unit);
						});
						unlock();
					}
				);
			}
		);
	});
}

function handlePrimaryAATrigger(mci, unit, address, arrDefinition, arrPostedUnits, onDone) {
	db.takeConnectionFromPool(function (conn) {
		conn.query("BEGIN", function () {
			var batch = kvstore.batch();
			readMcUnit(conn, mci, function (objMcUnit) {
				readUnit(conn, unit, function (objUnit) {
					var arrResponses = [];
					var trigger = getTrigger(objUnit, address);
					handleTrigger(conn, batch, trigger, {}, arrDefinition, address, mci, objMcUnit, false, arrResponses, function(){
						conn.query("DELETE FROM aa_triggers WHERE mci=? AND unit=? AND address=?", [mci, unit, address], function(){
							var batch_start_time = Date.now();
							batch.write(function(err){
								console.log("AA batch write took "+(Date.now()-batch_start_time)+'ms');
								if (err)
									throw Error("AA composer: batch write failed: "+err);
								conn.query("COMMIT", function () {
									conn.release();
									arrResponses.forEach(function (objAAResponse) {
										if (objAAResponse.response_unit)
											arrPostedUnits.push(objAAResponse.response_unit);
										eventBus.emit('aa_response', objAAResponse);
										eventBus.emit('aa_response_to_unit-'+objAAResponse.trigger_unit, objAAResponse);
										eventBus.emit('aa_response_to_address-'+objAAResponse.trigger_address, objAAResponse);
										eventBus.emit('aa_response_from_aa-'+objAAResponse.aa_address, objAAResponse);
									});
									onDone();
								});
							});
						});
					});
				});
			});
		});
	});
}

function readMcUnit(conn, mci, handleUnit) {
	conn.query("SELECT unit FROM units WHERE main_chain_index=? AND is_on_main_chain=1", [mci], function (rows) {
		if (rows.length !== 1)
			throw Error("found " + rows.length + " MC units on MCI " + mci);
		readUnit(conn, rows[0].unit, handleUnit);
	});
}

function readUnit(conn, unit, handleUnit) {
	storage.readJoint(conn, unit, {
		ifNotFound: function () {
			throw Error("unit not found: " + unit);
		},
		ifFound: function (objJoint) {
			handleUnit(objJoint.unit);
		}
	});
}

function getTrigger(objUnit, receiving_address) {
	var trigger = { address: objUnit.authors[0].address, unit: objUnit.unit, outputs: {} };
	objUnit.messages.forEach(function (message) {
		if (message.app === 'data' && !trigger.data) // use the first data mesage, ignore the subsequent ones
			trigger.data = message.payload;
		else if (message.app === 'payment') {
			var payload = message.payload;
			var asset = payload.asset || 'base';
			payload.outputs.forEach(function (output) {
				if (output.address === receiving_address) {
					if (!trigger.outputs[asset])
						trigger.outputs[asset] = 0;
					trigger.outputs[asset] += output.amount; // in case there are several outputs
				}
			});
		}
	});
	if (Object.keys(trigger.outputs).length === 0)
		throw Error("no outputs to " + receiving_address);
	return trigger;
}

// the result is onDone(response_unit, bBounced)
function handleTrigger(conn, batch, trigger, stateVars, arrDefinition, address, mci, objMcUnit, bSecondary, arrResponses, onDone) {
	if (arrDefinition[0] !== 'autonomous agent')
		throw Error('bad AA definition ' + arrDefinition);
	var error_message = '';
	var responseVars = {};
	var template = arrDefinition[1];
	var bounce_fees = template.bounce_fees || {base: 10000};
	if (!bounce_fees.base)
		bounce_fees.base = 10000;
//	console.log('===== trigger.outputs', trigger.outputs);
	var objValidationState = { last_ball_mci: mci, assocBalances: {} };
	var objStateUpdate;
	var count = 0;

	// add the coins received in the trigger
	function updateInitialAABalances(cb) {
		objValidationState.assocBalances[address] = {};
		var arrAssets = Object.keys(trigger.outputs);
		conn.query(
			"SELECT asset, balance FROM aa_balances WHERE address=? AND asset IN(" + arrAssets.map(conn.escape).join(',') + ")",
			[address],
			function (rows) {
				var arrQueries = [];
				// 1. update balances of existing assets
				rows.forEach(function (row) {
					conn.addQuery(
						arrQueries,
						"UPDATE aa_balances SET balance=balance+? WHERE address=? AND asset=? ",
						[trigger.outputs[row.asset], address, row.asset]
					);
					objValidationState.assocBalances[address][row.asset] = row.balance + trigger.outputs[row.asset];
				});
				// 2. insert balances of new assets
				var arrExistingAssets = rows.map(function (row) { return row.asset; });
				var arrNewAssets = _.difference(arrAssets, arrExistingAssets);
				if (arrNewAssets.length > 0) {
					var arrValues = arrNewAssets.map(function (asset) {
						objValidationState.assocBalances[address][asset] = trigger.outputs[asset];
						return "(" + conn.escape(address) + ", " + conn.escape(asset) + ", " + trigger.outputs[asset] + ")"
					});
					conn.addQuery(arrQueries, "INSERT INTO aa_balances (address, asset, balance) VALUES "+arrValues.join(', '));
				}
				async.series(arrQueries, cb);
			}
		);
	}

	function updateFinalAABalances(arrConsumedOutputs, objUnit, cb) {
		var assocDeltas = {};
		arrConsumedOutputs.forEach(function (output) {
			if (!assocDeltas[output.asset])
				assocDeltas[output.asset] = 0;
			assocDeltas[output.asset] -= output.amount;
		});
		var arrNewAssets = [];
		objUnit.messages.forEach(function (message) {
			if (message.app !== 'payment')
				return;
			var payload = message.payload;
			var asset = payload.asset || 'base';
			payload.outputs.forEach(function (output) {
				if (output.address !== address)
					return;
				if (!assocDeltas[asset]) { // it can happen if the asset was issued by AA
					assocDeltas[asset] = 0;
					arrNewAssets.push(asset);
				}
				assocDeltas[asset] += output.amount;
			});
		});
		var arrQueries = [];
		if (arrNewAssets.length > 0) {
			var arrValues = arrNewAssets.map(function (asset) { return "(" + conn.escape(address) + ", " + conn.escape(asset) + ", 0)"; });
			conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO aa_balances (address, asset, balance) VALUES "+arrValues.join(', '));
		}
		for (var asset in assocDeltas) {
			if (assocDeltas[asset])
				conn.addQuery(arrQueries, "UPDATE aa_balances SET balance=balance+? WHERE address=? AND asset=?", [assocDeltas[asset], address, asset]);
		}
		async.series(arrQueries, cb);
	}
	
	// note that app=definition is also replaced using the current trigger and vars, its code has to generate "{}"-formulas in order to be dynamic
	function replace(obj, name, path, locals, cb) {
		count++;
		if (count % 100 === 0) // interrupt the call stack
			return setImmediate(replace, obj, name, locals, cb);
		locals = _.clone(locals);
		var value = obj[name];
		if (typeof name === 'string') {
			var f = aa_validation.getFormula(name);
			if (f !== null) {
				var opts = {
					conn: conn,
					formula: f,
					trigger: trigger,
					locals: _.clone(locals),
					stateVars: stateVars,
					responseVars: responseVars,
					objValidationState: objValidationState,
					address: address
				};
				return formulaParser.evaluate(opts, function (err, res) {
					if (res === null)
						return cb(err.bounce_message || "formula " + f + " failed: "+err);
					delete obj[name];
					if (res === '')
						return cb(); // the key is just removed from the object
					if (typeof res !== 'string')
						return cb("result of formula " + name + " is not a string: " + res);
					if (res in obj)
						return cb("duplicate key " + res + " calculated from " + name);
					if (aa_validation.getFormula(res) !== null)
						return cb("calculated value of " + name + " looks like a formula again: " + res);
					obj[res] = value;
					replace(obj, res, path, locals, cb);
				});
			}
		}
		if (typeof value === 'number' || typeof value === 'boolean')
			return cb();
		if (typeof value === 'string') {
			var f = aa_validation.getFormula(value);
			if (f === null)
				return cb();
		//	console.log('path', path, 'name', name, 'f', f);
			var bStateUpdates = (path === '/messages/state');
			if (bStateUpdates) {
				if (objStateUpdate)
					return cb("second state update formula: " + f + ", existing: " + objStateUpdate.formula);
				objStateUpdate = {formula: f, locals: locals};
				return cb();
			}
			var opts = {
				conn: conn,
				formula: f,
				trigger: trigger,
				locals: locals,
				stateVars: stateVars,
				responseVars: responseVars,
				objValidationState: objValidationState,
				address: address,
				bObjectResultAllowed: true
			};
			formulaParser.evaluate(opts, function (err, res) {
			//	console.log('--- f', f, '=', res, typeof res);
				if (res === null)
					return cb(err.bounce_message || "formula " + f + " failed: "+err);
				if (res === '') { // signals that the key should be removed (only empty string, cannot be false as it is a valid value for asset properties)
					if (typeof name === 'string')
						delete obj[name];
					else
						obj[name] = null;
				}
				else
					obj[name] = res;
				cb();
			});
		}
		else if (aa_validation.hasCases(value)) {
			var thecase;
			async.eachSeries(
				value.cases,
				function (acase, cb2) {
					if (!("if" in acase)) {
						thecase = acase;
						return cb2('done');
					}
					var f = aa_validation.getFormula(acase.if);
					if (f === null)
						return cb2("case if is not a formula: " + acase.if);
					var locals_tmp = _.clone(locals); // separate copy for each iteration of eachSeries
					var opts = {
						conn: conn,
						formula: f,
						trigger: trigger,
						locals: locals_tmp,
						stateVars: stateVars,
						responseVars: responseVars,
						objValidationState: objValidationState,
						address: address
					};
					formulaParser.evaluate(opts, function (err, res) {
						if (res === null)
							return cb2(err.bounce_message || "formula " + acase.if + " failed: " + err);
						if (res) {
							thecase = acase;
							locals = locals_tmp;
							return cb2('done');
						}
						cb2(); // try next
					});
				},
				function (err) {
					if (!err)
						return cb("neither case is true in " + name);
					if (err !== 'done')
						return cb(err);
					var replacement_value = thecase[name];
					if (!replacement_value)
						throw Error("a case was selected but no replacement value in " + name);
					obj[name] = replacement_value;
					if (!thecase.init)
						return replace(obj, name, path, locals, cb);
					var f = aa_validation.getFormula(thecase.init);
					if (f === null)
						return cb("case init is not a formula: " + thecase.init);
					var opts = {
						conn: conn,
						formula: f,
						trigger: trigger,
						locals: locals,
						stateVars: stateVars,
						responseVars: responseVars,
						bStatementsOnly: true,
						objValidationState: objValidationState,
						address: address
					};
					formulaParser.evaluate(opts, function (err, res) {
						if (res === null)
							return cb(err.bounce_message || "formula " + f + " failed: " + err);
						replace(obj, name, path, locals, cb);
					});
				}
			);
		}
		else if (typeof value === 'object' && (typeof value.if === 'string' || typeof value.init === 'string')) {
			function evaluateIf(cb2) {
				if (typeof value.if !== 'string')
					return cb2();
				var f = aa_validation.getFormula(value.if);
				if (f === null)
					return cb("if is not a formula: " + value.if);
				var opts = {
					conn: conn,
					formula: f,
					trigger: trigger,
					locals: locals,
					stateVars: stateVars,
					responseVars: responseVars,
					objValidationState: objValidationState,
					address: address
				};
				formulaParser.evaluate(opts, function (err, res) {
					if (res === null)
						return cb(err.bounce_message || "formula " + value.if + " failed: " + err);
					if (!res) {
						if (typeof name === 'string')
							delete obj[name];
						else
							obj[name] = null; // will be removed
						return cb();
					}
					delete value.if;
					cb2();
				});
			}
			evaluateIf(function () {
				if (typeof value.init !== 'string')
					return replace(obj, name, path, locals, cb);
				var f = aa_validation.getFormula(value.init);
				if (f === null)
					return cb("init is not a formula: " + value.init);
				var opts = {
					conn: conn,
					formula: f,
					trigger: trigger,
					locals: locals,
					stateVars: stateVars,
					responseVars: responseVars,
					bStatementsOnly: true,
					objValidationState: objValidationState,
					address: address
				};
				formulaParser.evaluate(opts, function (err, res) {
					if (res === null)
						return cb(err.bounce_message || "formula " + value.init + " failed: " + err);
					delete value.init;
					replace(obj, name, path, locals, cb);
				});
			});
		}
		else if (Array.isArray(value)) {
			async.eachOfSeries(
				value,
				function (elem, i, cb2) {
					replace(value, i, path, _.clone(locals), cb2);
				},
				function (err) {
					if (err)
						return cb(err);
					var replacement_value = value.filter(function (elem) { return (elem !== null); });
					if (replacement_value.length === 0) {
						if (typeof name === 'string')
							delete obj[name];
						else
							obj[name] = null; // to be removed
						return cb();
					}
					obj[name] = replacement_value;
					cb();
				}
			);
		}
		else if (isNonemptyObject(value)) {
			async.eachSeries(
				Object.keys(value),
				function (key, cb2) {
					replace(value, key, path + '/' + key, _.clone(locals), cb2);
				},
				function (err) {
					if (err)
						return cb(err);
					if (Object.keys(value) === 0) {
						if (typeof name === 'string')
							delete obj[name];
						else
							obj[name] = null; // to be removed
						return cb();
					}
					cb();
				}
			);
		}
		else
			throw Error('unknown type of value in ' + name);
	}

	function pickParents(handleParents) {
		// first look for a chain of AAs stemming from the MC unit
		conn.query(
			"SELECT units.unit \n\
			FROM units CROSS JOIN unit_authors USING(unit) CROSS JOIN aa_addresses USING(address) \n\
			WHERE latest_included_mc_index=? AND aa_addresses.mci<=? \n\
			ORDER BY level DESC LIMIT 1",
			[mci, mci],
			function (rows) {
				if (rows.length > 0)
					return handleParents([rows[0].unit]);
				// next, check if there is an AA stemming from a recent MCI
				conn.query(
					"SELECT units.unit, latest_included_mc_index \n\
					FROM units CROSS JOIN unit_authors USING(unit) CROSS JOIN aa_addresses USING(address) \n\
					WHERE (main_chain_index>? OR main_chain_index IS NULL) AND aa_addresses.mci<=? \n\
					ORDER BY latest_included_mc_index DESC, level DESC LIMIT 1",
					[mci, mci],
					function (rows) {
						if (rows.length > 0) {
							var row = rows[0];
							if (row.latest_included_mc_index >= mci)
								throw Error("limci of last AA > mci");
							return handleParents([row.unit, objMcUnit.unit].sort());
						}
						handleParents([objMcUnit.unit]);
					}
				);
			}
		);
	}

	var bBouncing = false;
	function bounce(error) {
		console.log('bouncing with error', error, new Error().stack);
		objStateUpdate = null;
		error_message = error_message ? (error_message + ', then ' + error) : error;
		if (bBouncing)
			return finish(null);
		bBouncing = true;
		if (bSecondary)
			return finish(null);
		var messages = [];
		for (var asset in trigger.outputs) {
			var amount = trigger.outputs[asset];
			if (bounce_fees[asset] && bounce_fees[asset] >= amount)
				continue;
			var bounced_amount = amount - (bounce_fees[asset] || 0);
			messages.push({app: 'payment', payload: {asset: asset, outputs: [{address: trigger.address, amount: bounced_amount}]}});
		}
		if (messages.length === 0)
			return finish(null);
		sendUnit(messages);
	}

	function sendUnit(messages) {
		console.log('send unit with messages', JSON.stringify(messages, null, '\t'));
		var arrUsedOutputIds = [];
		var arrConsumedOutputs = [];

		function completeMessage(message) {
			message.payload_location = 'inline';
			message.payload_hash = objectHash.getBase64Hash(message.payload, true);
		}

		function completePaymentPayload(payload, additional_amount, cb) {
			var asset = payload.asset || null;
			var is_base = (asset === null) ? 1 : 0;
			payload.inputs = [];
			var total_amount = 0;
			var target_amount = payload.outputs.reduce(function (acc, output) { return acc + output.amount; }, additional_amount);
			var bFound = false;

			function iterateUnspentOutputs(rows) {
				for (var i = 0; i < rows.length; i++){
					var row = rows[i];
					var input = { unit: row.unit, message_index: row.message_index, output_index: row.output_index };
					arrUsedOutputIds.push(row.output_id);
					arrConsumedOutputs.push({asset: asset || 'base', amount: row.amount});
					payload.inputs.push(input);
					total_amount += row.amount;
					if (is_base)
						target_amount += TRANSFER_INPUT_SIZE;
					if (total_amount < target_amount)
						continue;
					if (total_amount === target_amount && payload.outputs.length > 0) {
						bFound = true;
						break;
					}
					var change_amount = total_amount - (target_amount + is_base * OUTPUT_SIZE);
					if (change_amount > 0) {
						payload.outputs.push({ address: address, amount: change_amount });
						bFound = true;
						break;
					}
				}
			}

			function readStableOutputs(handleRows) {
			//	console.log('--- readStableOutputs');
				// byte outputs less than 60 bytes (which are net negative) are ignored to prevent dust attack: spamming the AA with very small outputs so that the AA spends all its money for fees when it tries to respond
				conn.query(
					"SELECT unit, message_index, output_index, amount, output_id \n\
					FROM outputs \n\
					CROSS JOIN units USING(unit) \n\
					WHERE address=? AND asset"+(asset ? "="+conn.escape(asset) : " IS NULL AND amount>=60")+" AND is_spent=0 \n\
						AND sequence='good' AND main_chain_index<=? \n\
						AND output_id NOT IN("+(arrUsedOutputIds.length === 0 ? "-1" : arrUsedOutputIds.join(', '))+") \n\
					ORDER BY main_chain_index, unit, output_index", // sort order must be deterministic
					[address, mci], handleRows
				);
			}

			function readUnstableOutputsSentByAAs(handleRows) {
			//	console.log('--- readUnstableOutputsSentByAAs');
				conn.query(
					"SELECT outputs.unit, message_index, output_index, amount, output_id \n\
					FROM units \n\
					CROSS JOIN outputs USING(unit) \n\
					CROSS JOIN unit_authors USING(unit) \n\
					CROSS JOIN aa_addresses ON unit_authors.address=aa_addresses.address \n\
					WHERE outputs.address=? AND asset"+(asset ? "="+conn.escape(asset) : " IS NULL AND amount>=60")+" AND is_spent=0 \n\
						AND sequence='good' AND (main_chain_index>? OR main_chain_index IS NULL) \n\
						AND output_id NOT IN("+(arrUsedOutputIds.length === 0 ? "-1" : arrUsedOutputIds.join(', '))+") \n\
					ORDER BY latest_included_mc_index, level, outputs.unit, output_index", // sort order must be deterministic
					[address, mci], handleRows
				);
			}

			function issueAsset(cb2) {
				var objAsset = assetInfos[asset];
				if (objAsset.issued_by_definer_only && address !== objAsset.definer_address)
					return cb2("not a definer");
				var issue_amount = objAsset.cap || (target_amount - total_amount);

				function addIssueInput(serial_number){
					var input = {
						type: "issue",
						amount: issue_amount,
						serial_number: serial_number
					};
					payload.inputs.unshift(input);
					total_amount += issue_amount;
					var change_amount = total_amount - target_amount;
					if (change_amount > 0)
						payload.outputs.push({ address: address, amount: change_amount });
					cb2();
				}
				
				if (objAsset.cap) {
					conn.query("SELECT 1 FROM inputs WHERE type='issue' AND asset=?", [asset], function(rows){
						if (rows.length > 0) // already issued
							return cb2('already issued');
						addIssueInput(1);
					});
				}
				else{
					conn.query(
						"SELECT MAX(serial_number) AS max_serial_number FROM inputs WHERE type='issue' AND asset=? AND address=?",
						[asset, address],
						function(rows){
							var max_serial_number = (rows.length === 0) ? 0 : rows[0].max_serial_number;
							addIssueInput(max_serial_number+1);
						}
					);
				}
			}

			function sortOutputsAndReturn() {
				payload.outputs.sort(sortOutputs);
				cb();
			}

			readStableOutputs(function (rows) {
				iterateUnspentOutputs(rows);
				if (bFound)
					return sortOutputsAndReturn();
				readUnstableOutputsSentByAAs(function (rows2) {
					iterateUnspentOutputs(rows2);
					if (bFound)
						return sortOutputsAndReturn();
					if (!asset)
						return cb('not enough funds for ' + target_amount + ' bytes');
					issueAsset(function (err) {
						if (err) {
							console.log("issue failed: " + err);
							return cb('not enough funds for ' + target_amount + ' of asset ' + asset);
						}
						sortOutputsAndReturn();
					});
				});
			});
		}

		for (var i = 0; i < messages.length; i++){
			var message = messages[i];
			if (message.app !== 'payment')
				continue;
			var payload = message.payload;
			// negative or fractional
			if (!payload.outputs.every(function (output) { return isNonnegativeInteger(output.amount); }))
				return bounce("negative or fractional amounts");
			// filter out 0-outputs
			payload.outputs = payload.outputs.filter(function (output) { return (output.amount > 0); });
		}
		// remove messages with no outputs
		messages = messages.filter(function (message) { return (message.app !== 'payment' || message.payload.outputs.length > 0); });
		if (messages.length === 0) {
			error_message = 'no messages after removing 0-outputs';
			console.log(error_message);
			return handleSuccessfulEmptyResponseUnit(null);
		}
		var objBasePaymentMessage;
		var arrOutputAddresses = [];
		var assetInfos = {};
		async.eachSeries(
			messages,
			function (message, cb) {
				if (message.app !== 'payment') {
					if (message.app === 'definition')
						message.payload.address = objectHash.getChash160(message.payload.definition);
					completeMessage(message);
					return cb();
				}
				var payload = message.payload;
				payload.outputs.forEach(function (output) {
					if (output.address !== address && arrOutputAddresses.indexOf(output.address) === -1)
						arrOutputAddresses.push(output.address);
				});
				if (payload.asset === 'base')
					delete payload.asset;
				var asset = payload.asset || null;
				if (asset === null) {
					if (objBasePaymentMessage)
						return cb("already have base payment");
					objBasePaymentMessage = message;
					return cb(); // skip it for now, we can estimate the fees only after all other messages are in place
				}
				storage.loadAssetWithListOfAttestedAuthors(conn, asset, mci, [address], function (err, objAsset) {
					if (err)
						return cb(err);
					if (objAsset.fixed_denominations) // will skip it later
						return cb();
					assetInfos[asset] = objAsset;
					completePaymentPayload(payload, 0, function (err) {
						if (err)
							return cb(err);
						completeMessage(message);
						cb();
					});
				});
			},
			function (err) {
				if (err)
					return bounce(err);
				messages = messages.filter(function (message) { return (message.app !== 'payment' || !message.payload.asset || !assetInfos[message.payload.asset].fixed_denominations); });
				if (messages.length === 0) {
					error_message = 'no mesaages after removing fixed denominations';
					console.log(error_message);
					return handleSuccessfulEmptyResponseUnit(null);
				}
				if (!objBasePaymentMessage) {
					objBasePaymentMessage = { app: 'payment', payload: { outputs: [] } };
					messages.push(objBasePaymentMessage);
				}
				// add payload_location and wrong payload_hash
				objBasePaymentMessage.payload_location = 'inline';
				objBasePaymentMessage.payload_hash = '-'.repeat(44);
				var objUnit = {
					version: constants.version, 
					alt: constants.alt,
					timestamp: objMcUnit.timestamp,
					messages: messages,
					authors: [{ address: address }],
					last_ball_unit: objMcUnit.last_ball_unit,
					last_ball: objMcUnit.last_ball,
					witness_list_unit: objMcUnit.witnesses ? objMcUnit.unit : objMcUnit.witness_list_unit
				};
				pickParents(function (parent_units) {
					objUnit.parent_units = parent_units;
					objUnit.headers_commission = objectLength.getHeadersSize(objUnit);
					objUnit.payload_commission = objectLength.getTotalPayloadSize(objUnit);
					var size = objUnit.headers_commission + objUnit.payload_commission;
					console.log('unit before completing bytes payment', JSON.stringify(objUnit, null, '\t'));
					completePaymentPayload(objBasePaymentMessage.payload, size, function (err) {
					//	console.log('--- completePaymentPayload', err);
						if (err)
							return bounce(err);
						completeMessage(objBasePaymentMessage); // fixes payload_hash
						objUnit.payload_commission = objectLength.getTotalPayloadSize(objUnit);
						objUnit.unit = objectHash.getUnitHash(objUnit);
						executeStateUpdateFormula(objUnit.unit, function (err) {
							if (err)
								return bounce(err);
							validateAndSaveUnit(objUnit, function (err) {
								if (err)
									return bounce(err);
								updateFinalAABalances(arrConsumedOutputs, objUnit, function () {
									if (arrOutputAddresses.length === 0)
										return updateStateVarsAndFinish(objUnit.unit);
									updateStateVars();
									addResponse(objUnit.unit, function () {
										handleSecondaryTriggers(objUnit, arrOutputAddresses);
									});
								});
							});
						});
					});
				});
			}
		);
	}

	function executeStateUpdateFormula(response_unit, cb) {
		if (!objStateUpdate || bBouncing)
			return cb();
		var opts = {
			conn: conn,
			formula: objStateUpdate.formula,
			trigger: trigger,
			locals: objStateUpdate.locals,
			stateVars: stateVars,
			responseVars: responseVars,
			bStateVarAssignmentAllowed: true,
			bStatementsOnly: true,
			objValidationState: objValidationState,
			address: address,
			response_unit: response_unit
		};
		formulaParser.evaluate(opts, function (err, res) {
		//	console.log('--- state update formula', objStateUpdate.formula, '=', res);
			if (res === null)
				return cb(err.bounce_message || "formula " + objStateUpdate.formula + " failed: "+err);
			cb();
		});
	}

	function updateStateVars() {
		for (var address in stateVars) {
			var addressVars = stateVars[address];
			for (var var_name in addressVars) {
				var state = addressVars[var_name];
				if (!state.updated)
					continue;
				if (state.value === true)
					state.value = 1; // affects secondary triggers that execute after ours
				if (bSecondary) // do not save yet, will save all in primary
					continue;
				var key = "st\n" + address + "\n" + var_name;
				if (state.value === false) // false value signals that the should be deleted
					batch.del(key);
				else
					batch.put(key, state.value.toString()); // Decimal converted to string
			}
		}
	}

	function updateStateVarsAndFinish(response_unit) {
		if (bBouncing)
			return finish(response_unit);
		updateStateVars();
		finish(response_unit);
	}

	function handleSuccessfulEmptyResponseUnit() {
		executeStateUpdateFormula(null, function (err) {
			if (err) {
				error_message = undefined; // remove error message like 'no messages after filtering'
				return bounce(err);
			}
			updateStateVarsAndFinish(null);
		});
	}

	function addResponse(response_unit, cb) {
		var response = {};
		if (!bBouncing && Object.keys(responseVars).length > 0)
			response.responseVars = responseVars;
		if (error_message)
			response.error = error_message;
		var objAAResponse = {
			mci: mci,
			trigger_address: trigger.address,
			trigger_unit: trigger.unit,
			aa_address: address,
			bounced: bBouncing,
			response_unit: response_unit,
			response: response,
		};
		arrResponses.push(objAAResponse);
		conn.query(
			"INSERT INTO aa_responses (mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response) \n\
			VALUES (?, ?,?,?, ?,?,?)",
			[mci, trigger.address, address, trigger.unit, bBouncing ? 1 : 0, response_unit, JSON.stringify(response)],
			function () {
				cb();
			}
		);
	}

	function finish(response_unit) {
		if (bBouncing && bSecondary) {
			if (response_unit)
				throw Error('response_unit with bouncing a secondary AA');
			return onDone(response_unit, bBouncing);
		}
		addResponse(response_unit, function () {
			onDone(response_unit, bBouncing);
		});
	}

	function handleSecondaryTriggers(objUnit, arrOutputAddresses) {
		conn.query("SELECT address, definition FROM aa_addresses WHERE address IN(?) AND mci<=? ORDER BY address", [arrOutputAddresses, mci], function (rows) {
			if (rows.length === 0)
				return onDone(objUnit.unit, bBouncing);
			if (bBouncing)
				throw Error("secondary triggers while bouncing");
			async.eachSeries(
				rows,
				function (row, cb) {
					var child_trigger = getTrigger(objUnit, row.address);
					var arrChildDefinition = JSON.parse(row.definition);
					handleTrigger(conn, batch, child_trigger, stateVars, arrChildDefinition, row.address, mci, objMcUnit, true, arrResponses, function (secondary_unit, bBounced) {
						if (bBounced)
							return cb('bounced');
						cb();
					});
				},
				function (err) {
					if (err) {
						// revert
						if (bSecondary)
							return bounce("a sub-secondary AA bounced");
						// remove the rolled back units from caches and correct is_free of their parents if necessary
						console.log('will revert responses ' + JSON.stringify(arrResponses, null, '\t'));
						var arrResponseUnits = [];
						arrResponses.forEach(function (objAAResponse) {
							if (objAAResponse.response_unit)
								arrResponseUnits.push(objAAResponse.response_unit);
						});
						console.log('will revert response units ' + arrResponseUnits.join(', '));
						if (arrResponseUnits.length > 0) {
							var first_unit = arrResponseUnits[0];
							var objFirstUnit = storage.assocUnstableUnits[first_unit];
							var parent_units = objFirstUnit.parent_units;
							arrResponseUnits.forEach(storage.forgetUnit);
							storage.fixIsFreeAfterForgettingUnit(parent_units);
						}
						arrResponses.splice(0, arrResponses.length); // start over
						Object.keys(stateVars).forEach(function (address) { delete stateVars[address]; });
						batch.clear();
						conn.query("ROLLBACK", function () {
							conn.query("BEGIN", function () {
								// initial AA balances were rolled back, we have to add them again
								updateInitialAABalances(function () {
									bounce("one of secondary AAs bounced");
								});
							});
						});
						return;
					}
					onDone(objUnit.unit, bBouncing);
				}
			);
		});
	}

	function validateAndSaveUnit(objUnit, cb) {
		var objJoint = { unit: objUnit, aa: true };
		validation.validate(objJoint, {
			ifJointError: function (err) {
				throw Error("AA validation joint error: " + err);
			},
			ifUnitError: function (err) {
				console.log("AA validation unit error: " + err);
				return cb(err);
			},
			ifTransientError: function (err) {
				throw Error("AA validation transient error: " + err);
			},
			ifNeedHashTree: function () {
				throw Error("AA validation unexpected need hash tree");
			},
			ifNeedParentUnits: function (arrMissingUnits) {
				throw Error("AA validation unexpected dependencies: " + arrMissingUnits.join(", "));
			},
			ifOkUnsigned: function () {
				throw Error("AA validation returned ok unsigned");
			},
			ifOk: function (objAAValidationState, validation_unlock) {
				if (objAAValidationState.sequence !== 'good')
					throw Error("nonserial AA");
				validation_unlock();
				objAAValidationState.conn = conn;
				objAAValidationState.batch = batch;
				writer.saveJoint(objJoint, objAAValidationState, null, function(err){
					if (err)
						throw Error('AA writer returned error: ' + err);
					cb();
				});
			}
		}, conn);
	}


	updateInitialAABalances(function () {

		// these errors must be thrown after updating the balances
		if (arrResponses.length >= 10) // max number of responses per primary trigger
			return bounce("max number of responses per trigger exceeded");
		// being able to pay for bounce fees is not required for secondary triggers as they never actually send any bounce response or change state when bounced
		if (!bSecondary) {
			if ((trigger.outputs.base || 0) < bounce_fees.base) {
				error_message = 'received bytes are not enough to cover bounce fees';
				return finish(null);
			}
			for (var asset in trigger.outputs) { // if not enough asset received to pay for bounce fees, ignore silently
				if (bounce_fees[asset] && trigger.outputs[asset] < bounce_fees[asset]) {
					error_message = 'received ' + asset + ' is not enough to cover bounce fees';
					return finish(null);
				}
			}
		}

		replace(arrDefinition, 1, '', {}, function (err) {
			if (err)
				return bounce(err);
			var messages = template.messages;
			if (!messages) {
				error_message = 'no messages';
				console.log(error_message);
				return finish(null);
			}
			// this will also filter out the special message that performs the state changes
			messages = messages.filter(function (message) { return ('payload' in message && (message.app !== 'payment' || 'outputs' in message.payload)); });
			if (messages.length === 0) { // eat the received coins and send no response, state changes are still performed
				error_message = 'no messages after filtering';
				console.log(error_message);
				return handleSuccessfulEmptyResponseUnit(null);
			}
			messages.forEach(function (message) {
				var payload = message.payload;
				if (message.app === 'asset' && isNonemptyArray(payload.denominations))
					payload.denominations.sort(sortDenominations);
				if ((message.app === 'asset' || message.app === 'asset_attestors') && isNonemptyArray(payload.attestors))
					payload.attestors.sort();
			});
			sendUnit(messages);
		});
	});

}

function sortOutputs(a,b){
	var addr_comparison = a.address.localeCompare(b.address);
	return addr_comparison ? addr_comparison : (a.amount - b.amount);
}

function sortDenominations(a,b){
	return (a.denomination - b.denomination);
}


exports.handleAATriggers = handleAATriggers;
exports.handleTrigger = handleTrigger;
