var express = require('express');
var bodyParser = require('body-parser');
var xml2js = require('xml2js');
var Promise = require('promise');
var path = require('path');
var fs = require('fs');
var util = require('util');

var app = express();
var forms;

require('promise/lib/rejection-tracking').enable();

// Define where draft forms will be looked for and where they will be stored
var srcFolder = path.resolve('src/forms');// .../<app>/<form>.xhtml
// Defines where forms will be published to
var pubFolder = path.resolve('WEB-INF/resources/forms'); // .../<app>/<form>/form/form.xhtml

console.log('folders are', srcFolder, pubFolder);

// Use the simple text body parser for POST requests
app.use(bodyParser.text({ type: '*/xml' }));

// Form builder (form draft) handling
app.post('/search/orbeon/builder', function handleBuilderSearch(req, res, next) {
  xml2js.parseString(req.body, function parsedBuilderSearch(err, result) {
    if (err) {
      res.status(400).send(err.message);
      next();
      return;
    }

    console.log('parsed xml', util.inspect(result, { depth: null }));

    next();
  });
});

// Log everything
app.all('*', function(req, res, next) {
  console.log(new Date(), 'Got new request', req.method, req.url, req.headers, req.body);
  next();
});

require('./lib/forms-watcher')({
  srcFolder: srcFolder
}).then(function(formsObject) {
  forms = formsObject;

  app.listen('6483');
  console.log('CRUD API instance now listening on 6483');
}).catch(function(err) {
  console.error(err.message, error.stack);
});
