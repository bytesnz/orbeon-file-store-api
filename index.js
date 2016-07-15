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
// TODO The request MUST have a Content-Type: application/xml header.
app.use(bodyParser.text({ type: '*/xml' }));

// Get form for form builder
app.get('/crud/orbeon/builder/data/:id/data.xml', function getForm(req, res, next) {
  // Check id is in forms
  console.log('request for form', req.params);
  if (forms.forms[req.params.id]) {
    console.log('form no exist', forms.forms[req.params.id]);
    res.sendFile(forms.forms[req.params.id].file, next);
  } else {
    console.log('form no exist', req.params.id);
    res.status(404);
    next();
  }
});

// Form builder (form draft) handling
app.post('/search/orbeon/builder', function handleBuilderSearch(req, res, next) {
  xml2js.parseString(req.body, function parsedBuilderSearch(err, result) {
    if (err) {
      res.status(400).send(err.message);
      next();
      return;
    }

    console.log('parsed xml', util.inspect(result, { depth: null }));

    if (result.search) {
      var i, last, size, number,
          formsTotal = Object.keys(forms.forms).length;

      if (result.search['page-size']) {
        size = parseInt(result.search['page-size'][0]);
      }

      if (size && result.search['page-number']) {
        number = parseInt(result.search['page-number'][0]);
        i = (number - 1) * size;
        last = Math.min(i + size, formsTotal);
      } else {
        number = 1;
        i = 0;
        last = formsTotal;
      }

      // Create a map for the details
      var details = [];

      result.search.query.forEach(function(query) {
        if (typeof query === 'object') {
          details.push(query.$.name);
        }
      });

      var order = [];

      // Order forms by created date
      Object.keys(forms.forms).forEach(function(form) {
        var data = {
          id: form,
          date: forms.forms[form].btime.getTime()
        }, i;

        for (i = 0; i < order.length; i++) {
          if (order[i].date > data.date) {
            break;
          }
        }

        order.splice(i, 0, data);
      });

      // Extract just the ids
      ids = order.map(function(item) {
        return item.id;
      });

      // Generate response
      var response = {
        documents: {
          '$': {
            'search-total': formsTotal,
            'page-size': size,
            'page-number': number,
            'query': ''
          },
          'document': []
        }
      };
      var documents = response.documents.document;
      var form;
      var formData;

      for (i; i < last; i++) {
        form = forms.forms[ids[i]];
        formData = {
          '$': {
            'created': form.btime.toISOString(),
            'last-modified': form.mtime.toISOString(),
            'name': ids[i],
            'operations': 'read write update delete'
          },
          'details': {
            'detail': []
          }
        };

        // Add the details
        details.forEach(function(detail) {
          if (form[detail]) {
            formData.details.detail.push(form[detail]);
          } else {
            formData.details.detail.push('');
          }
        });

        documents.push(formData);
      }

      var builder = new xml2js.Builder();
      var responseXml = builder.buildObject(response);

      console.log(responseXml);
      res.type('application/xml').send(responseXml);
    }

    next();
  });
});

// Save Form
app.post();

// Publish Form
app.post();

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
