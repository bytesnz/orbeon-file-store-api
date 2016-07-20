var express = require('express');
var bodyParser = require('body-parser');
var xml2js = require('xml2js');
var Promise = require('promise');
var path = require('path');
var fs = require('fs');
var util = require('util');
var mkdirp = require('mkdirp-promise');
var process = require('process');
var log = require('npmlog');

var commander = require('commander')
  .option('-d, --debug', 'Debug logging')
  .option('-v, --verbose', 'Verbose logging')
  .parse(process.argv);

var access = Promise.denodeify(fs.access);
var writeFile = Promise.denodeify(fs.writeFile);
var unlink = Promise.denodeify(fs.unlink);

var app = express();
var forms;

if (commander.debug) {
  log.level = 'silly';
} else if (commander.verbose) {
  log.level = 'verbose';
}

log.enableColor();

require('promise/lib/rejection-tracking').enable();

// Define where draft forms will be looked for and where they will be stored
var srcFolder = path.resolve('src/forms');// .../<app>/<form>.xhtml
// Defines where forms will be published to
var pubFolder = path.resolve('WEB-INF/resources/forms'); // .../<app>/<form>/form/form.xhtml

log.verbose('folders are', srcFolder, pubFolder);

// Use the simple text body parser for POST requests
// TODO The request MUST have a Content-Type: application/xml header.
app.use(bodyParser.text({
  type: '*/xml',
  limit: '10mb'
}));

// Log everything
app.all('*', function(req, res, next) {
  log.verbose(new Date(), 'Got new request', req.method, req.url);
  log.silly('request parts', req.headers, req.body);
  next();
});

// Get form for form builder
app.get('/crud/orbeon/builder/data/:id/data.xml', function getForm(req, res, next) {
  // Check id is in forms
  log.silly('request for form', req.params);
  if (forms.forms[req.params.id]) {
    log.verbose('form exist', forms.forms[req.params.id]);
    res.sendFile(forms.forms[req.params.id].file, next);
  } else {
    log.warn('form no exist', req.params.id);
    res.status(404);
    next();
  }
});

// Get published form
app.get('/crud/:app/:form/form/form.xml', function getForm(req, res, next) {
  // Check id is in forms
  log.silly('request for published form', req.params);
  
  return (new Promise(function(resolve, reject) {
    // Look up form id
    var id = forms.getFormId(req.params.app, req.params.form)
    if (forms.forms[id]) {
      log.verbose('form exist', forms.forms[id]);
      resolve();
    } else {
      reject();
    }
  })).then(function() {
    // Check if published file exist
    var publishedFile = path.join(pubFolder, form['application-name'],
        form['form-name'], 'form', 'form.xhtml');
    
    return access(publishedFile, fs.R_OK).then(function() {
      log.warn('published form exist', req.params.app, req.params.form);
      res.sendFile(publishedFile, next);
      return Promise.resolve();
    }, function (err) {
      if (err.code === 'ENOENT') {
        return Promise.reject(err);
      } else {
        log.error(err.message);
        log.error(err.stack);
        res.status(500);
        next();
        return Promise.resolve();
      }
    });
  }).catch(function(err) {
    log.warn('published form no exist', req.params.app, req.params.form);
    res.status(404);
    next();
  });
});

// Delete a form
app.delete('/crud/orbeon/builder/data/:id/data.xml', function getForm(req, res, next) {
  var form;
  // Check id is in forms
  if ((form = forms.forms[req.params.id])) {
    unlink(form.file).then(function() {
      // Check if a published form exists
      var publishedFile = path.join(pubFolder, form['application-name'],
          form['form-name'], 'form', 'form.xhtml');
      return access(publishedFile, fs.W_OK).then(function() {
        // Delete it
        return unlink(publishedFile);
      }, function(err) {
        if (err.code === 'ENOENT') {
          return Promise.resolve();
        } else {
          return Promise.reject(err);
        }
      }).then(function() {
        log.warn(form['application-name'] + '/' + form['form-name'], 'deleted');
        forms.deleteMapping(form['application-name'], form['form-name']);
        delete forms.forms[req.params.id];
        res.status(201).end();
        next();
      });
    }).catch(function(err) {
      log.error(err.message);
      log.error(err.stack);
      res.status(500).send(err.message);
      next();
    });
  } else {
    log.warn('form no exist', req.params.id);
    res.status(400);
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

    log.silly('parsed xml', util.inspect(result, { depth: null }));

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

      log.silly(responseXml);
      res.type('application/xml').send(responseXml);
    }

    next();
  });
});

// Save Form
// /crud/orbeon/builder/data/419a29bc6ecad15209dbfdbc7ee6c3f8e53e88e7/data.xml
app.put('/crud/orbeon/builder/data/:id/data.xml', function saveForm(req, res, next) {
  // Extract the metadata from the new form
  // TODO Ensure form data is valid?
  return forms.extractMetadata(req.body).then(function(metadata) {
    // Check the folder exists
    var formPath = path.join(srcFolder, metadata['application-name'],
        metadata['form-name'] + '.xhtml');

    return access(path.dirname(formPath), fs.W_OK)
        .then(function appFolderGood() {
      // Check access to file
      return access(formPath, fs.W_OK).catch(function(err) {
        switch(err.code) {
          case 'ENOENT': // Does not exist
            // That's fine
            return Promise.resolve();
          default:
            return Promise.reject(err);
        }
      });
    }, function appFolderIssue(err) {
      switch(err.code) {
        case 'ENOENT': // Does not exist
          // Try creating the directory
          return mkdirp(path.dirname(formPath));
        default:
          return Promise.reject(err);
      }
    }).then(function saveHasFolder() {
      var oldId;

      // Check if id is already used
      if (forms.forms[req.params.id]) {
        var form = forms.forms[req.params.id];

        // Check that it is still the same form
        if (metadata['application-name'] !== form['application-name']
            || metadata['form-name'] !== form['form-name']) {
          // If not, move the old form to a new id
          var newId = forms.newId(40);
          
          log.warn('moving', form['application-name'], form['form-name'],
              'from', req.params.id, 'to', newId);
          
          forms.forms[newId] = form;
          // Fix new mapping
          forms.setIdMapping(newId, form['application-name'], form['form-name']);
        }
      }
      
      // Check if form already has id
      if ((oldId = forms.getFormId(metadata['application-name'],
          metadata['form-name']))) {
        // Check it is the same, if not move it
        if (oldId !== req.params.id) {
          log.warn('changing mapping from', oldId, 'to', req.params.id);
          forms.forms[req.params.id] = forms.forms[oldId];
          delete forms.forms[oldId];
          forms.setIdMapping(req.params.id, metadata['application-name'],
              metadata['form-name']);
        }
      }
      
      // Set id to form mapping so when the other data is
      // loaded by the watcher it uses the correct id
      forms.setIdMapping(req.params.id, metadata['application-name'],
          metadata['form-name']);

      log.info('form', metadata['application-name'] + '/'
          + metadata['form-name'], 'saved (' + req.params.id + ')');
      return writeFile(formPath, req.body);
    }).then(function() {
      res.status(201).end();
    });
    next();
  }).catch(function(err) {
    log.error(err.message, err.stack);
    res.status(500).send(err.message);
    next();
  })
});

// Publish Form
app.put('/crud/:app/:form/form/form.xhtml', function saveForm(req, res, next) {
  console.log('got publish of form');
  // Extract the metadata from the new form
  return forms.extractMetadata(req.body).then(function(metadata) {
    // Check the folder exists
    var publishedFile = path.join(pubFolder, req.params.app,
        req.params.form, 'form', 'form.xhtml');

    // Check the folder exists first
    return access(path.dirname(publishedFile), fs.W_OK)
        .then(function appFolderGood() {
      // Check access to file
      return access(publishedFile, fs.W_OK).catch(function(err) {
        switch(err.code) {
          case 'ENOENT': // Does not exist
            // That's fine
            return Promise.resolve();
          default:
            return Promise.reject(err);
        }
      });
    }, function appFolderIssue(err) {
      switch(err.code) {
        case 'ENOENT': // Does not exist
          // Try creating the directory
          return mkdirp(path.dirname(publishedFile));
        default:
          return Promise.reject(err);
      }
    }).then(function saveHasFolder() {
      // TODO do we need to check all the metadata etc?
      log.info('form', req.params.app + '/'
          + req.params.form, 'published (' + req.query.document + ')');
      return writeFile(publishedFile, req.body);
    }).then(function() {
      res.status(201).end();
    });
    next();
  }).catch(function(err) {
    log.error(err.message, err.stack);
    res.status(500).send(err.message);
    next();
  });
});

require('./lib/forms-watcher')({
  srcFolder: srcFolder
}).then(function(formsObject) {
  forms = formsObject;

  Object.keys(forms.forms).forEach(function(id) {
    var form = forms.forms[id];
    log.verbose(id, ':', form['application-name'], form['form-name'],
        form.file, form.title);
  });

  app.listen('6483');
  log.info('CRUD API instance now listening on 6483');
}).catch(function(err) {
  log.error(err.message, error.stack);
});
