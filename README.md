Motorboat - A Digital Ocean Provisioning Library
=========

Motorboat is a Node.js library that allows you to provision [Digital Ocean](https://www.digitalocean.com/) droplets (instances) from a series of one or more Bash scripts.

## Example

Create a new instance of Motorboat, passing it an object of configuration settings.

```javascript
var Motorboat = require('motorboat'),
	motorboat;

motorboat = new Motorboat({
    'client_id': 'digital_ocean_client_id',
    'api_key': 'digital_ocean_api_key',
    'scripts_path': '../../some_scripts',
    'ssh_key_id': 'digital_ocean_ssh_key_id',
    'public_ssh_key': '/path/to/public_ssh_key.pub',
    'private_ssh_key': '/path/to/private_ssh_key'
});

motorboat.provision({
    'name': 'agent2',
    'size': '66',
    'image': '3101045',
    'region': '4',
    'private_networking': true,
    'scripts': ['node']
}, function(err, results) {
	console.log(err, results);
});
```

## Configuration Settings

```
client_id - Digital Ocean API Client ID

api_key - Digital Ocean API Key

scripts_path - Optional. The location of a folder containing bash scripts that will be used to provision new droplets (see below).

ssh_key_id - The ID of an SSH key that has already been created and assigned to your Digital Ocean account.

public_ssh_key - The path to the public SSH key referenced by the 'ssh_key_id' option.

private_ssh_key - The path to the private SSH key referenced by the 'ssh_key_id' option.
```

## Provisioning Scripts

Motorboat uses Bash scripts to provision newly created droplets (instances). Here's an example script that installs [Node.js](http://nodejs.org):

```bash
#!/bin/bash
# Installs Node.JS

apt-get install -y python-software-properties
apt-add-repository ppa:chris-lea/node.js
apt-get update
apt-get install -y nodejs=0.10.28-1chl1~precise1
apt-get install -y npm=0.10.28-1chl1~precise1

exit 0
```
