'use strict';

var method = require('./../method');
var assign = require('lodash.assign');
var path = require('path');
var mkdirp = require('mkdirp');
var async = require('async');
var os = require('os');
var fs = require('fs');
var archiver = require('archiver');
var ProgressBar = require('progress');
var projectConfig = require('./../projectConfig');
var jobs_logs = require('./../jobs/logs.js');
var jobs_waitfor = require('./../jobs/waitfor.js');
var jobs_show = require('./../jobs/show.js');

/**
 * @memberof jobs
 * @method create
 * @description Create a new Paperspace job, and tail its log output if run at the command line. To disable the tailing behavior specify '--tail false'.  Note: if a project is not defined for the current working directory, and you are running in command line mode, a project configuration settings file will be created.  Use '--init false' or specify '--project [projectname]' to override this behavior.
 * @param {object} params - Job creation parameters
 * @param {string} params.container - A required reference to a container name or container link to be used for the job.
 * @param {string} [params.machineType] - An optional machine type to run the job on: either 'GPU+', 'P4000', 'P5000', 'P6000', 'V100', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', or 'C10'.<p>Defaults to 'GPU+'.
 * @param {string} [params.name] - An optional name or description for this job.  If ommitted, the job name defaults to 'job for project [projectname]'.
 * @param {string} [params.project] - The name of the project for this job.  If not provided, this is taken from the .ps_project/config.json file, or the current directory name.
 * @param {string} [params.projectId] - The poject id of an existing project for this job.  Note: if projectId is specified, the project parameter cannot be specified.
 * @param {string} [params.command] - An optional command to run within the workspace or container.
 * @param {string} [params.workspace] - An optional path to a workspace, or link to a git repository to upload and merge with the container.  If a zip file name is provided it is uploaded instead.  If no workspace is provided the current directory is zipped up and transferred.  If the workspace is 'none', no workspace is merged and the container is run as-is.
 * @param {string} [params.dataset] - An optional reference to a dataset to be merged with the container.
 * @param {string} [params.registryUsername] - An optional username for accessing an image hosted on a private container registry.  Note: you must specify this option every time a private image is specified for the container.
 * @param {string} [params.registryPassword] - An optional password for accessing an image hosted on a private container registry.  Note: you must specify this option every time a private image is specified for the container.
 * @param {string} [params.workspaceUsername] - An optional username for accessing a private git repository.  Note: you must specify this option every time a private git repository is specified for the workspace.
 * @param {string} [params.workspacePassword] - An optional password for accessing a private git repository.  We recommned using an OAuth token (GitHub instructions can be found <a href="https://help.github.com/articles/creating-a-personal-access-token-for-the-command-line/">here</a>).  Note: you must specify this option every time a private git repository is specified for the workspace.
 * @param {boolean} [params.tail] - Optional; defaults to true in command line mode only.  Specify false to disable automatic tailing.
 * @param {boolean} [params.json] - Optional; if true, do not write progress to standard out.  '--json' with no value is equivalent to true.
 * @param {function} cb - Node-style error-first callback function
 * @returns {object} job - The created job JSON object
 * @example
 * paperspace.jobs.create({
 *   container: 'http://dockerhub.com/mycontainer',
 *   machineType: 'P6000',
 * }, function(err, res) {
 *   // handle error or result
 * });
 * @example
 * $ paperspace jobs create \
 *     --container "http://dockerhub.com/mycontainer" \
 *     --machineType "P5000"
 * @example
 * # HTTP request:
 * https://api.paperspace.io
 * POST /jobs/createJob { "container": "http://dockerhub.com/mycontainer", "machineType": "P5000" }
 * x-api-key: 1ba4f98e7c0...
 * # Returns 201 on success
 * @example
 * // Example return value:
 * {
 *   "id": "j123abc",
 *   "name": "job for project myproject",
 *   "state": "Pending",
 *   "workspaceUrl": "myproject.zip",
 *   "workingDirectory": "/paperspace",
 *   "artifactsDirectory": "/artifacts",
 *   "entrypoint": "echo Hello Paperspace",
 *   "projectId": "pr456def",
 *   "project": "myproject",
 *   "container": "http://dockerhub.com/mycontainer",
 *   "machineType": "P5000",
 *   "cluster": "Jobs",
 *   "usageRate": "P5000 hourly",
 *   "startedByUserId": "u789ghi",
 *   "parentJobId": null,
 *   "jobError": null,
 *   "dtCreated": "2017-11-30T18:46:10.394Z",
 *   "dtModified": "2017-11-30T18:46:10.394Z",
 *   "dtProvisioningStarted": null,
 *   "dtProvisioningFinished": null,
 *   "dtStarted": null,
 *   "dtFinished": null,
 *   "dtTeardownStarted": null,
 *   "dtTeardownFinished": null,
 *   "dtDeleted": null,
 *   "exitCode": null
 * }
 */

function expandHomeDir(pathIn) {
	var homedir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
	if (!pathIn) return pathIn;
	if (pathIn == '~') return homedir;
	if (pathIn.slice(0, 2) !== '~/') return pathIn;
	return path.join(homedir, pathIn.slice(2));
}

function directorySize(_path, cb, size) {
  if (size === undefined) {
    size = 0;
  }

	// NOTE: must match exclusion list for archive.glob()
	var name = path.basename(_path);
	if (name === '.git' || name === '.gitignore') {
		cb(null, size);
		return;
	}

  fs.stat(_path, function(err, stat) {
    if (err) {
      cb(err);
      return;
    }

    size += stat.size;

    if (!stat.isDirectory()) {
      cb(null, size);
      return;
    }

    fs.readdir(_path, function(err, paths) {
      if (err) {
        cb(err);
        return;
      }

      async.map(paths.map(function(p) { return _path + '/' + p; }), directorySize, function(err, sizes) {
        size += sizes.reduce(function(a, b) { return a + b; }, 0);
        cb(err, size);
      });
    });
  });
}

var MAX_UPLOAD_SIZE = 104857600; // 100MB

function create(params, cb) {
	var json = false;
	if (params.json) {
		json = true;
		// Note: we don't delete params.json because lib/request.js needs to examine it to determine if upload progress should be displayed
	}
	var init = true;
	if (params.init) {
		init = params.init;
		delete params.init;
	}
	var tail = global.paperspace_cli && !json; // tail defaults to true in cli mode, false otherwise;
	if (typeof params.tail === 'boolean') {
		tail = params.tail;
		delete params.tail;
	}

	// XXX TODO trim leading/trailing spaces from input paths
	// XXX TODO whitelist git services
	// XXX TODO convert to gzip
	// XXX TODO stream compress

	var cwd = process.cwd();
	if (!params.project && !params.projectId) {
		// default to name of project in .ps_project/config.json or name of current directory
		params.project = projectConfig.getProject();
		if (!params.project) {
			params.project = path.basename(cwd);
			if (params.project === '/') {
				return ifCliPrintErrorOnly(new Error('Error: cannot create project from root dir. Please create a project dir and run from there.'));
			}
			if (global.paperspace_cli && !json && init) {
				var config = { 'project': params.project };
				var configDir = path.resolve(cwd, '.ps_project');
				if (!fs.existsSync(configDir)) mkdirp.sync(configDir);
				else if (!fs.statSync(configDir).isDirectory()) {
					return ifCliPrintErrorOnly(new Error('Error: existing file with same name as .ps_project directory.'));
				}

				var configFileName = path.resolve(configDir, 'config.json');
				if (fs.existsSync(configFileName) && !fs.statSync(configFileName).isFile()) {
					return ifCliPrintErrorOnly(new Error('Error: config file not accessible: ' + configFileName));
				}

				fs.writeFileSync(configFileName, JSON.stringify(config, null, 2) + '\n');

				// refresh projectConfig state
				params.project = projectConfig.getProject();

				console.log('New project name: ' + params.project);
			}
		}
	}

	if (params.container && typeof params.container !== 'string') return ifCliPrintErrorOnly(new Error('Parameter `container` expected to be a string'));
	if (params.workspace && typeof params.workspace !== 'string') return ifCliPrintErrorOnly(new Error('Parameter `workspace` expected to be a string'));

	if (params.machineType) projectConfig.setMachineType(params.project, params.machineType);
	else params.machineType = projectConfig.getMachineType();

	if (params.container) projectConfig.setContainer(params.project, params.container);
	else params.container = projectConfig.getContainer();

	if (params.command) projectConfig.setCommand(params.project, params.command);
	else params.command = projectConfig.getCommand();

	if (params.workspace) projectConfig.setWorkspace(params.project, params.workspace);
	else params.workspace = projectConfig.getWorkspace();

	if (params.name) projectConfig.setName(params.project, params.name);
	else params.name = projectConfig.getName();

	if (params.dataset) projectConfig.setDataset(params.project, params.dataset);
	else params.dataset = projectConfig.getDataset();

	if (!params.container) return ifCliPrintErrorOnly(new Error('Missing required parameter `container`'));

	if (!params.workspace) params.workspace = cwd;

	function ifCliPrintErrorOnly(err) {
		if (global.paperspace_cli && !json) {
			console.log(err.message);
			return cb();
		}
		return cb(err);
	}

	function maybeTailLogs(err, res) {
		if (global.paperspace_cli && !json && tail) {
			if (err) return cb(err);
			if (!res.id) return new Error('Job create failed; job id not found.');
			var jobId = res.id;
			console.log('New jobId: ' + res.id);
			console.log('Job ' + res.state);
			if (res.state === 'Pending') console.log('Waiting for job to run...');
			return jobs_waitfor({ jobId: jobId, state: 'Running' }, function _waitforCb(err, res) {
				if (err) return cb(err);
				if (!res.state) return new Error('Job state not found.');
				var state = res.state;
				console.log('Job ' + state);
				if (state !== 'Stopped' && state !== 'Failed' && state !== 'Running') {
					if (state === 'Error' || res.jobError) console.log('Error: ' + res.jobError);
					return cb();
				}
				console.log('Awaiting logs...');
				return jobs_logs({ jobId: jobId, tail: true  }, function _logsCb(err) {
					if (err) return cb(err);
					return jobs_show({ jobId: jobId }, function _showCb(err, res) {
						if (err) return cb(err);
						if (!res.state) return new Error('Job state not found.');
						console.log('Job ' + res.state + (res.exitCode || res.exitCode === 0 ? ', exitCode ' + res.exitCode : ''));
						if (res.state === 'Error' || res.jobError) console.log('Error: ' + res.jobError);
						return cb();
					});
				});
			});
		}
		return cb(err, res);
	}

	// don't allow zipping of the root directory
	if (params.workspace === '/') {
		return ifCliPrintErrorOnly(new Error('Error: cannot zip workspace from root directory.'));
	}

	if (params.workspace !== 'none' && !params.workspace.startsWith('https://') && !params.workspace.startsWith('git+https://')) {
		params.workspace = expandHomeDir(params.workspace);
		if (!fs.existsSync(params.workspace)) {
			return ifCliPrintErrorOnly(new Error('Error: cannot find workspace file or directory.'));
		}
		var stat = fs.statSync(params.workspace);
		if (!stat.isDirectory() && !stat.isFile()) {
			return ifCliPrintErrorOnly(new Error('Error: workspace is not a file or directory.'));
		}

		// zip the workspace file if it is not already a zip file
		if (!params.workspace.endsWith('.zip') && !params.workspace.endsWith('.gz')) {

			// construct zip file name in tmpdir
			var zip_file = path.resolve(os.tmpdir(), path.basename(params.workspace) + '.zip');

			// delete prior zip file if it exists
			if (fs.existsSync(zip_file)) {
				fs.unlinkSync(zip_file);
			}

			function zipFunc(err, totalSize) { // eslint-disable-line no-inner-declarations
				var output = fs.createWriteStream(zip_file);
				var archive = archiver('zip', {
					zlib: { level: 9 } // Sets the compression level.
				});

				// listen for all archive data to be written
				// 'close' event is fired only when a file descriptor is involved
				output.on('close', function() {
					// check it does not exceed the current limit for upload using loopback storage component with s3
					if (getFilesizeInBytes(zip_file) > MAX_UPLOAD_SIZE) {
						var err = new Error('Error: zipped workspace ' + zip_file + ' cannot exceed ' + MAX_UPLOAD_SIZE + ' bytes.');
						return ifCliPrintErrorOnly(err);
					}

					// save name of the workspace file for superagent to attach it
					params.workspace = zip_file;

					// save workspace file name as a extra parameter since we are not using multer to parse the files on the server
					params.workspaceFileName = path.basename(params.workspace);
					return method(create, params, function _methodCb(err, res) {
						if (err) return cb(err);
						if (res) projectConfig.setLastJobId(res.project, res.id);
						return maybeTailLogs(err, res);
					});
				});

				archive.on('error', function(err) {
					console.error('Error while zipping: ', err);
				});

				var bar;
				var prev_zipped = 0;

				if (stat.isDirectory() && global.paperspace_cli && !json) {
					archive.on('progress', function(progress) {
						if (!bar) {
							bar = new ProgressBar('Zipping directory ' + path.basename(params.workspace) + ' [:bar] :rate/bps :percent :etas', {
								complete: '=',
								incomplete: ' ',
								width: 40,
								total: totalSize,
							});
						}
						var chunkSize = progress.fs.processedBytes - prev_zipped;
						prev_zipped = progress.fs.processedBytes;
						bar.tick(chunkSize);
					});
				}

				// good practice to catch warnings (ie stat failures and other non-blocking errors)
				archive.on('warning', function(err) {
					if (err.code === 'ENOENT') {
						// log warning
						console.error(err.code);
					} else {
						// throw error
						throw err;
					}
				});

				archive.pipe(output);
				if (stat.isDirectory()) {
					// include . prefixed folders and files but exclude .git and .gitignore folders and files
					archive.glob('**/*', {
						cwd: params.workspace,
						ignore: ['**/.git/**', '**/.git', '**/.gitignore'],
						dot: true,
					}, false);
				} else {
					var basename = path.basename(params.workspace);
					archive.file(params.workspace, { name: basename } );
				}
				archive.finalize();
			}

			if (stat.isDirectory()) {
				directorySize(params.workspace, zipFunc);
			} else {
				if (global.paperspace_cli && !json) {
					console.log('Zipping file ' + path.basename(params.workspace));
				}
				zipFunc(null, getFilesizeInBytes(params.workspace));
			}
		} else {
			// workspace is a zip or gzip file

			// check it does not exceed the current limit for upload using loopback storage component with s3
			if (getFilesizeInBytes(params.workspace) > MAX_UPLOAD_SIZE) {
				var err = new Error('Error: zipped workspace ' + params.workspace + ' cannot exceed ' + MAX_UPLOAD_SIZE + ' bytes.');
				return ifCliPrintErrorOnly(err);
			}

			// save workspace file name as a extra parameter since we are not using multer to parse the files on the server
			params.workspaceFileName = path.basename(params.workspace);
			return method(create, params, function _methodCb(err, res) {
				if (err) return cb(err);
				if (res) projectConfig.setLastJobId(res.project, res.id);
				return maybeTailLogs(err, res);
			});
		}
	} else {
		// workspace is either a link or 'none'

		// if link pass in workspaceFileName param for jobs service to download it when running the job
		if (params.workspace.startsWith('https://') || params.workspace.startsWith('git+https://')) params.workspaceFileName = params.workspace;

		// don't try to upload it; we normally attempt to upload anything in the workspace param specified in assign() below
		delete params.workspace;
		return method(create, params, function _methodCb(err, res) {
			if (err) return cb(err);
			if (res) projectConfig.setLastJobId(res.project, res.id);
			return maybeTailLogs(err, res);
		});
	}
}

function getFilesizeInBytes(filename) {
  var stats = fs.statSync(filename);
  var fileSizeInBytes = stats['size'];
  return fileSizeInBytes;
}

assign(create, {
	auth: true,
	group: 'jobs',
	name: 'create',
	method: 'post',
	route: '/jobs/createJob',
	requires: {
		container: 'string',
	},
	file: 'workspace',
	returns: {},
});

module.exports = create;
