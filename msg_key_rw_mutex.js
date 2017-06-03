var $ = {};

var cluster = require('cluster');
var msg_tcp = require('./msg_tcp');
var msg_process = require('./msg_process');

var index = 0;

function MasterMutex(name, messager){
    var thiz = this;
    thiz.name = name;

    var map = new Map();
    var mutex_no_key = {
        ref_count: 0,
        wait_writer: [],
        wait_reader: [],
        status: 0,    //0, no action, 1, reading, 2, writing
        reading_peers: 0
    };

    //Add myself to mutexes
    messager.add(thiz.name, thiz);
    thiz.destroy = function(){
        messager.del(thiz.name);
    }

    var obtainKey = function(key) {
        var value;
        if(key === undefined)
            value = mutex_no_key;
        else{
            value = map.get(key);
            //console.log(value);
            if(value === undefined){
                value = {
                    ref_count: 0,
                    wait_writer: [],
                    wait_reader: [],
                    status: 0,    //0, no action, 1, reading, 2, writing
                    reading_peers: 0
                };
                map.set(key, value);
            }
        }

        value.ref_count++;
        return value;
    }
    var releaseKey = function(key, value) {
        value.ref_count--;
        if(value.ref_count == 0 && key !== undefined)
            map.delete(key);
    }
    var getKey = function(key){
        if(key === undefined) return mutex_no_key;
        return map.get(key);
    }

    var next = function(mutex, key) {
        //console.log('status ', mutex.status);
        setImmediate(function(){
            if(mutex.status == 0
                && mutex.wait_writer.length > 0){
                var op = mutex.wait_writer.shift();
                mutex.status = 2;
                op.resolve();
            }

            while((mutex.status == 0 || mutex.status == 1)
                && mutex.wait_reader.length > 0){
                var op = mutex.wait_reader.shift();
                mutex.status = 1;
                mutex.reading_peers++;
                op.resolve();
            }
        });
    }

    var unlock = function(mutex, key){
        if(mutex.status == 2)
            mutex.status = 0;
        else if(mutex.status == 1){
            if(mutex.reading_peers > 0){
                mutex.reading_peers--;
                if(mutex.reading_peers == 0)
                    mutex.status = 0;
            }
        }
        var ref_count = mutex.ref_count;
        releaseKey(key, mutex);
        if(ref_count > 1)
            next(mutex, key);
    }
    
    thiz.unlock_worker = function(key){
        var mutex = getKey(key);
        if(mutex === undefined) return;
        unlock(mutex, key);
    }

    thiz.wlock_worker = function(key, worker){
        var mutex = obtainKey(key);
        return new Promise(function(resolve, reject){
            mutex.wait_writer.push({resolve: resolve, reject: reject});
            next(mutex, key);
        }).then(function(){
            return messager.send_client(worker, {'m_cmd': 'wlock', 'm_name': thiz.name, 'm_type': thiz.type, 'm_key': key});
        });
    }

    thiz.rlock_worker = function(key, worker){
        var mutex = obtainKey(key);
        return new Promise(function(resolve, reject){
            mutex.wait_reader.push({resolve: resolve, reject: reject});
            next(mutex, key);
        }).then(function(){
            return messager.send_client(worker, {'m_cmd': 'rlock', 'm_name': thiz.name, 'm_type': thiz.type, 'm_key': key});
        });
    }

    thiz.wlock = function(key, func){
        var mutex = obtainKey(key);
        return new Promise(function(resolve, reject){
            mutex.wait_writer.push({resolve: resolve, reject: reject});
            next(mutex, key);
        }).then(function(){
            return func();
        }).then(function(ret){
            unlock(mutex, key);
            return ret;
        }, function(err){
            unlock(mutex, key);
            throw err;
        });
    }
    
    thiz.rlock = function(key, func){
        var mutex = obtainKey(key);
        return new Promise(function(resolve, reject){
            mutex.wait_reader.push({resolve: resolve, reject: reject});
            next(mutex, key);
        }).then(function(){
            return func();
        }).then(function(ret){
            unlock(mutex, key);
            return ret;
        }, function(err){
            unlock(mutex, key);
            throw err;
        });
    }
    
    thiz.size = function(){
        return map.size;
    }
}


function SlaveMutex(name, messager){
    var thiz = this;
    thiz.name = name;

    var wait_writer = new Map();
    var wait_reader = new Map();
    var wait_writer_no_key = [];
    var wait_reader_no_key = [];

    //Add myself to mutexes
    messager.add(thiz.name, thiz);
    thiz.destroy = function(){
        messager.del(thiz.name);
    }

    function get_wait_writer(key){
        if(key === undefined) return wait_writer_no_key;
        var value = wait_writer.get(key);
        if(value === undefined){
            value = [];
            wait_writer.set(key, value);
        }
        return value;
    }
    function get_wait_reader(key){
        if(key === undefined) return wait_reader_no_key;
        var value = wait_reader.get(key);
        if(value === undefined){
            value = [];
            wait_reader.set(key, value);
        }
        return value;
    }

    var unlock = function(key) {
        return messager.send({'m_cmd': 'unlock', 'm_name': thiz.name, 'm_type': thiz.type, 'm_key': key});
    }
    
    thiz.on_wlock = function(key){
        var values = get_wait_writer(key);
        var op = values.shift();
        if(values.length === 0)
            wait_writer.delete(key);
        op.resolve();
    }
    
    thiz.on_rlock = function(key){
        var values = get_wait_reader(key);
        var op = values.shift();
        if(values.length === 0)
            wait_reader.delete(key);
        op.resolve();
    }

    thiz.wlock = function(key, func) {
        return new Promise(function(resolve, reject){
            get_wait_writer(key).push({resolve: resolve, reject: reject});
            return messager.send({'m_cmd': 'wlock', 'm_name': thiz.name, 'm_type': thiz.type, 'm_key': key});
        }).then(function(){
            return func();
        }).then(function(ret){
            unlock(key);
            return ret;
        }, function(err){
            unlock(key);
            throw err;
        });
    }

    thiz.rlock = function(key, func) {
        return new Promise(function(resolve, reject){
            get_wait_reader(key).push({resolve: resolve, reject: reject});
            return messager.send({'m_cmd': 'rlock', 'm_name': thiz.name, 'm_type': thiz.type, 'm_key': key});
        }).then(function(){
            return func(); 
        }).then(function(ret){
            unlock(key);
            return ret;
        }, function(err){
            unlock(key);
            throw err;
        });
    }

    thiz.lock = thiz.wlock;
    
    thiz.size = function() {
        return wait_writer.size + wait_reader.size;
    }
}


function Mutex(name, host) {
    var thiz = this;
    
    function createMutex(name, host) {
        if(host === undefined){
            var new_name = (name === undefined ? index++ : name);
            var messager = msg_process.get();
            return (cluster.isMaster
                ? new MasterMutex(new_name, messager)
                : new SlaveMutex(new_name, messager));
        }
        else{
            return new SlaveMutex(name, msg_tcp.get(host));
        }
    }

    var mutex = createMutex(name, host);

    thiz.rlock = function(key, func) {
        if(func === undefined){
            func = key;
            key = undefined;
        }

        return mutex.rlock(key, func);
    }
    
    thiz.wlock = function(key, func) {
        if(func === undefined){
            func = key;
            key = undefined;
        }

        return mutex.wlock(key, func);
    }

    thiz.lock = thiz.wlock;
    
    thiz.size = function() {
        return mutex.size();
    }
    
    thiz.destroy = function(){
        return mutex.destroy();
    }
}

$.mutex = function(name, host) {
    return new Mutex(name, host);
}

$.server = function(port){
    return msg_tcp.listen_server(port);
}

module.exports = $;