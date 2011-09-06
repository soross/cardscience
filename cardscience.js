#!/usr/bin/env node
var util = require("util");

var csutil = require("./lib/util");

var cradle = require("cradle");

var zombie = require("zombie");

var url = require('url');

var base = require("./lib/models/base");
var card = require("./lib/models/card");

var nomnom = require("nomnom");

var Scraper = function() {
    var browser = new zombie.Browser({debug: true});
    browser.runScripts = false;

    // http://gatherer.wizards.com/Pages/Search/Default.aspx?page=0&output=standard&special=true&format=%5B%22Standard%22%5D
    this.scrapePage = function(page_no, success, failure) {
        fetchurl = { protocol: "http",
                host: "gatherer.wizards.com",
                pathname: "/Pages/Search/Default.aspx",
                query: {
                    page: page_no,
                    output: "standard",
                    special: "true", // what's this for?
                    format: '["Standard"]'
                }
              };

        console.log("Starting scrape fetch...");
        browser.visit(url.format(fetchurl), function(err, browser, status) {
            if(err) {
                console.log("Shit, couldn't fetch page from Gatherer.");
                // TODO if it failed, try again at least a few times before emitting error
                throw(err.message);
            }

            var verifyElements = function(element) {
                if(element === undefined) {
                    throw new Error("Attempt to find an element failed!");
                }
                return element;
            }

            var card_item_table = verifyElements(browser.document.querySelector(".cardItemTable"));
            var card_items = verifyElements(card_item_table.querySelectorAll("tr.cardItem"));

            // TODO dang, with forEach() we can't process the items in
            // sequence, yet still wait on asynchronous things.  this
            // is useful mostly so we can handle errors.  with
            // eachWait(), we can do just that.  however, it means
            // that we really are processing things synchronously and
            // end up spending a lot of time waiting for each CouchDB
            // insert to complete (admittedly, I'm not sure how well
            // CouchDB parallelizes creation on a single instance on a
            // machine).  we could do even better if we ran all the
            // jobs simultaneously, but only returned once all of them
            // had completed.
            card_items.update().eachWait(function(card_item, each_done, each_error) {
                var title = card_item.querySelector("span.cardTitle a").innerHTML;
                var set_versions = verifyElements(card_item.querySelector("td.setVersions"));
                var set_hyperlink_element = verifyElements(set_versions.querySelector('div[id$="cardSetCurrent"] > a'));
                var set_hyperlink = url.parse(set_hyperlink_element.href, true);
                var mid = set_hyperlink.query.multiverseid;
                console.log(mid + ": " + title);

                var createCard = function() {
                    var new_card = card.newInstance();
                    new_card.id = "mtg_card_" + mid;
                    new_card.title = title;
                    new_card.save(function() {
                        console.log("Successfully saved card: " + mid);
                        each_done();
                    }, function(error) {
                        console.log("Unable to save card: " + error);
                        each_error();
                    });
                };
                
                card.find("mtg_card_" + mid, function(found_card) {
                    console.log("Card with multiverse ID '" + mid + "' exists already, deleting.");
                    found_card.destroy(function() {
                        // done
                        createCard();
                    }, function() {
                        // error
                        console.log("Unable to delete existing card, what the crap");
                        each_error();
                    });
                }, function(error) {
                    // card not existing, going to make one
                    createCard();
                });
            }.bind(this), function() {
                // done
                var page_links = browser.document.querySelector('div.pagingControls')
                
                var second_last = page_links.childNodes[page_links.childNodes.length - 1];

                if(second_last.tagName === "A") {
                    console.log("More to do!");
                    this.scrapePage(page_no + 1, success, failure);
                } else {
                    console.log("On last page!");
                    success();
                }
            }.bind(this), function() {
                throw new Error("Problem dealing with a card item.");
            });
        }.bind(this));
    };

    this.scrapePage(0);
};

var CardScience = function() {
    console.log("Welcome to CardScience.");
    var options = nomnom.opts({
        installdb : {
            abbr: "i",
            help: "Install design documents into CouchDB",
            flag: true
        }
    }).parseArgs();
    var connection = new cradle.Connection();
    var db = connection.database("cardscience");
    

    var initialize = function() {
        var scraper = new Scraper();
        base.init(db);

        
        if(options.installdb) {
            base.Base.updateAllDesignDocuments(function() {
                console.log("Updated all design docs successfully.");
                // now that data model is properly initialized, do initial loads from DB, etc
                process.exit(0);
            }.bind(this), function(e) {
                console.log("Problem updating design documents: " + e.reason);
                process.exit(-1);
            });
        }
    };

    db.exists(function(err, exists) {
        if(err) {
            console.log('error', "Yikes, problem connecting to CouchDB: " + err);
        } else if(exists) {
            console.log("Database is ready.");
            initialize();
        } else {
            console.log("Database does not yet exist, creating it.");
            db.create();
            initialize();
        }
    });
};

new CardScience(function() {
    // success
    console.log("Success!");
}, function() {
    // failure
    console.log("Problems fetching the pages, giving up.");
});
