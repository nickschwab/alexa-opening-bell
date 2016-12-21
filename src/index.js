/**
 * This is a simple Alexa Skill to return the stock performance of publicly-traded companies
 *
 * Examples:
 * One-shot model:
 *  User: "Alexa, ask [App Name] for the price of Tesla Motors"
 *  Alexa: "..."
 */

var APP_ID = "";
var APP_NAME = "Opening Bell";

var MOD_BASE_URL = "http://dev.markitondemand.com/MODApis/Api/v2";
var YQL_BASE_URL = "http://query.yahooapis.com/v1/public/yql";
var VI_APP_TOKEN = '';

var http = require('http');
var async = require('async');
var overrides = require('./overrides');
var VoiceInsights = require('voice-insights-sdk');
require('string_score');

/**
 * The AlexaSkill prototype and helper functions
 */
var AlexaSkill = require('./AlexaSkill');

var MyApp = function () {
    AlexaSkill.call(this, APP_ID);
};

// Extend AlexaSkill
MyApp.prototype = Object.create(AlexaSkill.prototype);
MyApp.prototype.constructor = MyApp;

MyApp.prototype.eventHandlers.onSessionStarted = function (sessionStartedRequest, session) {
    VoiceInsights.initialize(session, VI_APP_TOKEN);
    console.log("MyApp onSessionStarted requestId: " + sessionStartedRequest.requestId
        + ", sessionId: " + session.sessionId);
    // any initialization logic goes here
};

MyApp.prototype.eventHandlers.onLaunch = function (launchRequest, session, response) {
    console.log("MyApp onLaunch requestId: " + launchRequest.requestId + ", sessionId: " + session.sessionId);
    response.ask("What stock price would you like me to look up?", "Say a company name, like 'Amazon', or say 'help' for additional instructions.");
};

/**
 * Overridden to show that a subclass can override this function to teardown session state.
 */
MyApp.prototype.eventHandlers.onSessionEnded = function (sessionEndedRequest, session) {
    console.log("MyApp onSessionEnded requestId: " + sessionEndedRequest.requestId
        + ", sessionId: " + session.sessionId);
    // any cleanup logic goes here
};

MyApp.prototype.intentHandlers = {
    "GetTickerIntent": function (intent, session, response) {
        var inputSlot = intent.slots.Company;
        console.log(inputSlot);
        if(!inputSlot.value){
            response.ask("I didn't quite hear that. What company would you like me to look up?");
        }else{
            handleTickerRequest((inputSlot && inputSlot.value ? inputSlot.value : null), response);
        }
    },

    "AMAZON.HelpIntent": function (intent, session, response) {
        VoiceInsights.track(intent.name);
        response.ask("I can tell you the stock price of any publicly traded company such as Apple, Tesla, Microsoft, and many more. Which would you like?");
    },

    "AMAZON.StopIntent": function (intent, session, response) {
        VoiceInsights.track(intent.name);
        response.tell("O.K.");
    },

    "AMAZON.CancelIntent": function (intent, session, response) {
        VoiceInsights.track(intent.name);
        response.tell("O.K.");
    }
};

function handleTickerRequest(company_name, response) {
    getTickerText(company_name, function(err, result){
        response.tell(result);
    });
}

function getTickerText(company_name, callback){
    async.waterfall([
        function(callback){
            // check for a override before doing an external API ticker Lookup
            async.detect(overrides, function(item, callback){
                async.detect(item.aliases, function(alias, callback){
                    callback(null, alias == company_name.toLowerCase());
                }, callback);
            }, function(err, match){
                callback(err, match ? match.ticker : null);
            });
        },
        function(symbol, callback){
            console.log("override symbol: " + symbol);
            if(symbol){
                callback(null, symbol);
                return;
            }

            async.waterfall([
                function(callback){
                    // look up the company's ticker
                    http.get(MOD_BASE_URL + "/Lookup/json?input=" + company_name, function(res){
                        var body = "";

                        res.on('data', function (chunk) {
                            body += chunk;
                        });

                        res.on('end', function () {
                            try{
                                var result = JSON.parse(body);

                                if(result.length){
                                    callback(null, result);
                                }else{
                                    callback("No matching companies", null);
                                }
                            }catch(e){
                                callback(e, null);
                            }
                        });
                    }).on('error', function (e) {
                        console.log("Got error: ", e);
                        callback(e, null);
                    });
                },
                function(companies, callback){
                    if(companies.length == 1){
                        // single search result, use it regardless of confidence match
                        callback(null, companies[0].Symbol);
                        return;
                    }

                    // sort array of company matches based on strongest name match, descending
                    async.sortBy(companies, function(company, callback){
                        console.log(company.Name.toLowerCase() + ": " + company_name.toLowerCase().score(company.Name.toLowerCase(), 1));
                        callback(null, company_name.toLowerCase().score(company.Name.toLowerCase(), 1)*-1);
                    }, function(err, sorted_companies){
                        // use the ticker symbol with the strongest name match confidence score
                        callback(err, sorted_companies[0].Symbol);
                    });
                }
            ], callback);
        },
        function(symbol, callback){
            async.parallel({
                "yql": function(callback){
                    getTickerTextFromYql(symbol, function(err, text){
                        if(err){
                            console.log(err);
                        }
                        callback(null, text);
                    });
                },
                "mod": function(callback){
                    getTickerTextFromMod(symbol, function(err, text){
                        if(err){
                            console.log(err);
                        }
                        callback(null, text);
                    });
                }
            }, function(err, result){
                var text = result.yql || result.mod || null;
                callback(null, text);
            });
        }
    ], function(err, result){
        if(err){
            console.log(err);
            console.log(result);
        }
        callback(null, err || !result ? "I can't access that company's data right now, please try again later." : result);
        VoiceInsights.track("GetTickerIntent", company_name, (err || !result ? "error" : "success"));
    });
}

// Create the handler that responds to the Alexa Request.
exports.handler = function (event, context) {
    // Create an instance of the MyApp skill.
    var skill = new MyApp();
    skill.execute(event, context);
};


function getTickerTextFromMod(symbol, callback){
    async.waterfall([
        function(callback){
            // get the stock price
            http.get(MOD_BASE_URL + "/Quote/json?symbol=" + symbol, function(res) {
                var body = "";

                res.on('data', function (chunk) {
                    body += chunk;
                });

                res.on('end', function () {
                    try{
                        var result = JSON.parse(body);

                        if(result.Name){
                            callback(null, result)
                        }else{
                            callback("No MOD price record for " + symbol, null);
                        }
                    }catch(e){
                        callback(e, null);
                    }
                });
            }).on('error', function (e) {
                console.log("Got error: ", e);
                callback(e, null);
            });
        },
        function(company, callback){
            // convert it into a readable string
            if(company){
                var text = company.Name + " is trading at " + (Math.round((Math.abs(company.LastPrice) + 0.00001) * 100) / 100) + ". ";
                if(company.ChangePercent > 0){
                    text += "Up " + (Math.round((Math.abs(company.ChangePercent) + 0.00001) * 100) / 100) + "%.";
                }else if(company.ChangePercent < 0){
                    text += "Down " + (Math.round((Math.abs(company.ChangePercent) + 0.00001) * 100) / 100) + "%.";
                }else{
                    text += "No change.";
                }
                callback(null, text);
            }else{
                callback("error", null);
            }
        }
    ], callback);
}


function getTickerTextFromYql(symbol, callback){
    async.waterfall([
        function(callback){
            // get the stock price
            http.get(YQL_BASE_URL + '?q=select%20*%20from%20yahoo.finance.quotes%20where%20symbol%20in%20("' + symbol + '")&format=json&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys&callback=', function(res) {
                var body = "";

                res.on('data', function (chunk) {
                    body += chunk;
                });

                res.on('end', function () {
                    try{
                        var result = JSON.parse(body);

                        if(result.query && result.query.results && result.query.results.quote){
                            callback(null, result.query.results.quote)
                        }else{
                            callback("No YQL price record for " + symbol, null);
                        }
                    }catch(e){
                        callback(e, null);
                    }
                });
            }).on('error', function (e) {
                console.log("Got error: ", e);
                callback(e, null);
            });
        },
        function(company, callback){
            // convert it into a readable string
            if(company){
                var text = company.Name + " is trading at " + (Math.round((Math.abs(company.LastTradePriceOnly) + 0.00001) * 100) / 100) + ". ";
                company.ChangeinPercent = parseFloat(company.ChangeinPercent);
                if(company.ChangeinPercent > 0){
                    text += "Up " + Math.abs(company.ChangeinPercent) + "%.";
                }else if(company.ChangeinPercent < 0){
                    text += "Down " + Math.abs(company.ChangeinPercent) + "%.";
                }else{
                    text += "No change.";
                }
                callback(null, text);
            }else{
                callback("error", null);
            }
        }
    ], callback);
}
