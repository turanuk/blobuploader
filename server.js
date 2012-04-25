var path = require('path');
if (path.existsSync('./../../lib/azure.js')) {
  azure = require('./../../lib/azure');
} else {
  azure = require('azure');
}

var express = require('express');
var helpers = require('./helpers.js');
var everyauth = require('everyauth');

var usersById = {};
var nextUserId = 0;

function addUser (source, sourceUser) {
  var user;
  if (arguments.length === 1) { // password-based
    user = sourceUser = source;
    user.id = ++nextUserId;
    return usersById[nextUserId] = user;
  } else { // non-password-based
    user = usersById[++nextUserId] = {id: nextUserId};
    user[source] = sourceUser;
  }
  return user;
}

var usersByLogin = {
    'finomial': addUser({login: 'finomial', password: 'finomial'})
  };

everyauth
  .password
    .loginWith('email')
    .getLoginPath('/login')
    .postLoginPath('/login')
    .loginView('login.ejs')
    .loginLocals( function (req, res, done) {
      setTimeout( function () {
        done(null, {
          title: 'Login'
        });
      }, 200);
    })
    .authenticate( function (login, password) {
      var errors = [];
      if (!login) errors.push('Missing login');
      if (!password) errors.push('Missing password');
      if (errors.length) return errors;
      var user = usersByLogin[login];
      if (!user) return ['User not found'];
      if (user.password !== password) return ['Password failed'];
      return user;
    })

    .getRegisterPath('/register')
    .postRegisterPath('/register')
    .registerView('register.ejs')
//    .registerLocals({
//      title: 'Register'
//    })
//    .registerLocals(function (req, res) {
//      return {
//        title: 'Sync Register'
//      }
//    })
    .registerLocals( function (req, res, done) {
      setTimeout( function () {
        done(null, {
          title: 'Async Register'
        });
      }, 200);
    })
    .validateRegistration( function (newUserAttrs, errors) {
      var login = newUserAttrs.login;
      if (usersByLogin[login]) errors.push('Login already taken');
      return errors;
    })
    .registerUser( function (newUserAttrs) {
      var login = newUserAttrs[this.loginKey()];
      return usersByLogin[login] = addUser(newUserAttrs);
    })

    .loginSuccessRedirect('/')
    .registerSuccessRedirect('/');

var app = module.exports = express.createServer();
// Global request options, set the retryPolicy
var blobClient = azure.createBlobService().withFilter(new azure.ExponentialRetryPolicyFilter());
var containerName = 'webpi';

//Configuration
app.configure(function () {
  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');
  app.use(express.methodOverride());
  app.use(express.bodyParser());
  app.use(express.cookieParser());
  app.use(express.session({secret: 'foo'}));
  app.use(everyauth.middleware());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});
everyauth.helpExpress(app);

app.configure('development', function () {
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function () {
  app.use(express.errorHandler());
});

app.param(':id', function (req, res, next) {
  next();
});

//Middleware for authentication
var authenticatedUser = function (req, res, next) {
  if (req.loggedIn) {
    next();
  } else {
    res.redirect('/login');
  }
}

//Routes
app.get('/', authenticatedUser, function (req, res) {
  res.render('index.ejs', { locals: {
    title: 'Welcome'
  }
  });
});

app.get('/Upload', authenticatedUser, function (req, res) {
  res.render('upload.ejs', { locals: {
    title: 'Upload File'
  }
  });
});

app.get('/Display', authenticatedUser, function (req, res) {
  blobClient.listBlobs(containerName, function (error, blobs) {
    res.render('display.ejs', { locals: {
      title: 'List of Blobs',
      serverBlobs: blobs
    }
    });
  });
});

app.get('/Download/:id', authenticatedUser, function (req, res) {
  blobClient.getBlobProperties(containerName, req.params.id, function (err, blobInfo) {
    if (err === null) {
      res.header('content-type', blobInfo.contentType);
      res.header('content-disposition', 'attachment; filename=' + blobInfo.metadata.filename);
      blobClient.getBlobToStream(containerName, req.params.id, res, function (err) {
        if (err) {
          console.log(err.message);
        }
      });
    } else {
      helpers.renderError(res);
    }
  });
});

app.post('/uploadhandler', authenticatedUser, function (req, res) {
  var formValid = true;
  if (req.body.itemName === '') {
    helpers.renderError(res);
    formValid = false;
  }
  if (formValid) {
    var extension = req.files.uploadedFile.name.split('.').pop();
    var newName  = req.body.itemName + '.' + extension;
    var options = {
      contentType: req.files.uploadedFile.type,
      metadata: { fileName: newName }
    }

    blobClient.createBlockBlobFromFile(containerName, req.body.itemName, req.files.uploadedFile.path, options, function (error) {
        if (error) {
          helpers.renderError(res);
        } else {
          res.redirect('/Display');
        }
    });
  }
});

app.post('/Delete/:id', authenticatedUser, function (req, res) {
  blobClient.deleteBlob(containerName, req.params.id, function (error) {
    if (error != null) {
      helpers.renderError(res);
    } else {
      res.redirect('/Display');
    }
  });
});

blobClient.createContainerIfNotExists(containerName, function (error) {
  if (error) {
    console.log(error);
  } else {
    setPermissions();
  }
});

function setPermissions() {
  blobClient.setContainerAcl(containerName, azure.Constants.BlobConstants.BlobContainerPublicAccessType.BLOB, function (error) {
    if (error) {
      console.log(error);
    } else {
      app.listen(process.env.port || 1337);
      console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    }
  });
}