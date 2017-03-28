import _ from 'lodash';
import AliasRewriter from './AliasRewriter';

// Map of commandName=commandHandlerFn
const inputCommands = {};

export default class InputHandler {
    constructor(state) {
        this.state = state;
        this.aliasRewriter = new AliasRewriter();

        this.aliasRewriter.importFromString(state.user_settings.aliases);

        state.$watch('user_settings.aliases', newVal => {
            this.aliasRewriter.importFromString(newVal);
        });

        this.addInputCommands();
        this.listenForInput();
    }


    listenForInput() {
        this.state.$on('input.raw', (input) => {
            let lines = input.split('\n');
            lines.forEach(line => this.processLine(line));
        });
    }


    processLine(rawLine) {
        let line = rawLine;
        let activeNetwork = this.state.getActiveNetwork();
        let activeBuffer = this.state.getActiveBuffer();

        // If no command specified, server buffers = send raw, channels/queries = send message
        if (line[0] !== '/') {
            if (activeBuffer.isServer()) {
                line = '/quote ' + line;
            } else {
                line = '/msg ' + activeBuffer.name + ' ' + line;
            }
        }

        let aliasVars = {
            server: activeNetwork.name,
            channel: activeBuffer.name,
            destination: activeBuffer.name,
            nick: activeNetwork.nick,
        };
        line = this.aliasRewriter.process(line, aliasVars);

        // Remove the / from the start of the line
        line = line.substr(1);

        let spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) spaceIdx = line.length;

        let command = line.substr(0, spaceIdx);
        let params = line.substr(spaceIdx + 1);

        let eventObj = {
            handled: false,
            raw: rawLine,
            command: command,
            params: params,
        };

        // Include command and params as their own arguments just for ease of use
        this.state.$emit('input.command.' + command, eventObj, command, params);

        if (!eventObj.handled) {
            activeNetwork.ircClient.raw(line);
        }
    }


    addInputCommands() {
        _.each(inputCommands, (fn, event) => {
            this.state.$on('input.command.' + event, fn.bind(this));
        });
    }
}


/**
 * The actual handler functions for commands. Called in context of the InputHandler instance
 * inputCommand['the /command name'] = function(){};
 */

// /lines allows aliases to send multiple commands, separated by |
inputCommands.lines = function inputCommandLines(event, command, line) {
    event.handled = true;

    line.split('|').forEach(subLine => {
        this.processLine(subLine.trim());
    });
};


function handleMessage(type, event, command, line) {
    event.handled = true;

    let network = this.state.getActiveNetwork();

    let spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) spaceIdx = line.length;

    let bufferName = line.substr(0, spaceIdx);
    let message = '';

    if (!network.isChannelName(bufferName)) {
        bufferName = this.state.getActiveBuffer().name;
        message = line;
    } else {
        message = line.substr(spaceIdx + 1);
    }

    let buffer = this.state.getBufferByName(network.id, bufferName);
    if (buffer) {
        let newMessage = {
            time: Date.now(),
            nick: this.state.getActiveNetwork().nick,
            message: message,
            type: type,
        };

        this.state.addMessage(buffer, newMessage);
    }

    let fnNames = {
        msg: 'say',
        action: 'action',
        notice: 'notice',
    };
    let fnName = fnNames[type] || 'say';
    network.ircClient[fnName](bufferName, message);
}

inputCommands.msg = function inputCommandMsg(event, command, line) {
    handleMessage.call(this, 'msg', event, command, line);
};
inputCommands.action = function inputCommandMsg(event, command, line) {
    handleMessage.call(this, 'action', event, command, line);
};
inputCommands.notice = function inputCommandMsg(event, command, line) {
    handleMessage.call(this, 'notice', event, command, line);
};


inputCommands.join = function inputCommandJoin(event, command, line) {
    event.handled = true;

    let spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) spaceIdx = line.length;

    let bufferNames = line.substr(0, spaceIdx).split(',');
    let keys = line.substr(spaceIdx + 1).split(',');

    let network = this.state.getActiveNetwork();

    // Only switch to the first channel we join if multiple are being joined
    let hasSwitchedActiveBuffer = false;
    bufferNames.forEach((bufferName, idx) => {
        // Prepend a # channel prefix if not specified already
        let chanName = network.isChannelName(bufferName) ?
            bufferName :
            '#' + bufferName;

        let newBuffer = this.state.addBuffer(network.id, chanName);

        if (newBuffer && !hasSwitchedActiveBuffer) {
            this.state.setActiveBuffer(network.id, newBuffer.name);
            hasSwitchedActiveBuffer = true;
        }

        network.ircClient.join(chanName, keys[idx]);
    });
};


inputCommands.part = function inputCommandPart(event, command, line) {
    event.handled = true;

    let network = this.state.getActiveNetwork();
    let bufferNames = [];
    let message = '';

    if (line === '') {
        // /part
        bufferNames = [this.state.getActiveBuffer().name];
    } else {
        let lineParts = line.split(' ');
        if (network.isChannelName(lineParts[0])) {
            // /part #channel,#possible_channel possible part message
            bufferNames = _.compact(lineParts[0].split(','));
            message = lineParts.slice(1).join(' ');
        } else {
            // /part possible part message
            bufferNames = [this.state.getActiveBuffer().name];
            message = line;
        }
    }

    bufferNames.forEach((bufferName) => {
        network.ircClient.part(bufferName, message);
    });
};


inputCommands.topic = function inputCommandTopic(event, command, line) {
    event.handled = true;

    let network = this.state.getActiveNetwork();
    let bufferName = '';
    let newTopic = '';

    if (line === '') {
        // /topic
        return;
    }

    let lineParts = line.split(' ');
    if (network.isChannelName(lineParts[0])) {
        // /topic #channel a topic
        bufferName = lineParts[0];
        newTopic = lineParts.slice(1).join(' ');
    } else {
        // /topic a topic
        bufferName = this.state.getActiveBuffer().name;
        newTopic = line;
    }

    network.ircClient.setTopic(bufferName, newTopic);
};


inputCommands.close = function inputCommandClose(event, command, line) {
    event.handled = true;

    let network = this.state.getActiveNetwork();
    let bufferNames = _.compact(line.split(/[, ]/));
    if (bufferNames.length === 0) {
        bufferNames = [this.state.getActiveBuffer().name];
    }

    bufferNames.forEach((bufferName) => {
        let buffer = network.bufferByName(bufferName);
        if (!buffer) {
            return;
        }

        network.ircClient.part(bufferName);
        this.state.removeBuffer(buffer);
    });
};


inputCommands.query = function inputCommandQuery(event, command, line) {
    event.handled = true;

    let nicks = line.split(' ');
    let network = this.state.getActiveNetwork();

    // Only switch to the first buffer we open if multiple are being opened
    let hasSwitchedActiveBuffer = false;
    nicks.forEach((bufferName, idx) => {
        let newBuffer = this.state.addBuffer(network.id, bufferName);

        if (newBuffer && !hasSwitchedActiveBuffer) {
            this.state.setActiveBuffer(network.id, newBuffer.name);
            hasSwitchedActiveBuffer = true;
        }
    });
};


inputCommands.nick = function inputCommandNick(event, command, line) {
    event.handled = true;

    let spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) spaceIdx = line.length;

    let newNick = line.substr(0, spaceIdx);
    let network = this.state.getActiveNetwork();
    network.ircClient.changeNick(newNick);
};


inputCommands.quote = function inputCommandQuote(event, command, line) {
    event.handled = true;

    let network = this.state.getActiveNetwork();
    network.ircClient.raw(line);
};


inputCommands.whois = function inputCommandWhois(event, command, line) {
    event.handled = true;

    let parts = line.split(' ');
    let network = this.state.getActiveNetwork();
    let buffer = this.state.getActiveBuffer();

    network.ircClient.whois(parts[0], parts[0], whoisData => {
        let out = [];
        let display = message => {
            if (!message) {
                return;
            }

            out.push(message);
        };
        let formats = {
            account: 'User account: {{account}}',
            server: 'Connected to server {{server}} ({{server_info}})',
            secure: 'Using a secure connection',
            channels: 'Also on channels {{channels}}',
            mask: '{{nick}}!{{user}}@{{host}} ({{real_name}})',
            idle: 'Idle for {{idle}} seconds',
            logon: 'Connected at {{logon}}',

            // The following entries will be ignored from whoisData as display() ignores
            // empty lines.
            nick: '',
            user: '',
            host: '',
            real_name: '',
            server_info: '',
        };

        // Display a select few entries first to keep a consistent order, and then
        // show any extra information at the end
        if (whoisData.account) {
            display(formats.account.replace('{{account}}', whoisData.account));
        }
        if (whoisData.nick) {
            display(
                formats.mask
                    .replace('{{nick}}', whoisData.nick)
                    .replace('{{user}}', whoisData.user)
                    .replace('{{host}}', whoisData.host)
                    .replace('{{real_name}}', whoisData.real_name)
            );
        }
        if (whoisData.server) {
            display(
                formats.server
                    .replace('{{server}}', whoisData.server)
                    .replace('{{server_info}}', whoisData.server_info)
            );
        }
        if (whoisData.secure) {
            display(formats.secure);
        }
        if (whoisData.idle) {
            let idleSeconds = Math.floor(parseInt(whoisData.idle, 10) / 1000);
            display(formats.idle.replace('{{idle}}', idleSeconds));
        }
        if (whoisData.logon) {
            let logonTime = parseInt(whoisData.logon, 10);
            if (!isNaN(logonTime)) {
                let logonDate = new Date(logonTime * 1000);
                display(formats.logon.replace('{{logon}}', logonDate));
            }
        }
        if (whoisData.channels) {
            display(formats.channels.replace('{{channels}}', whoisData.channels));
        }

        _.each(whoisData, (val, key) => {
            // Only include lines we haven't already used
            if (typeof formats[key] === 'undefined') {
                display(`${key}: ${val}`);
            }
        });

        this.state.addMessage(buffer, {
            nick: parts[0],
            message: out.join('\n'),
            type: 'whois',
        });
    });
};


inputCommands.clear = function inputCommandClear(event, command, line) {
    event.handled = true;

    let buffer = this.state.getActiveBuffer();
    let messages = buffer.getMessages();
    messages.splice(0, messages.length);

    this.state.addMessage(buffer, {
        nick: '*',
        message: 'Scrollback cleared',
    });
};


inputCommands.echo = function inputCommandEcho(event, command, line) {
    event.handled = true;

    let buffer = this.state.getActiveBuffer();

    this.state.addMessage(buffer, {
        nick: '*',
        message: line,
    });
};


inputCommands.server = function inputCommandServer(event, command, line) {
    event.handled = true;

    let parts = line.split(' ');
    let serverAddr = parts[0];
    let serverPort = parts[1] || 6667;
    let serverTls = false;
    let serverPassword = parts[2];
    let nick = parts[3] || 'ircuser';

    if (serverPort[0] === '+') {
        serverTls = true;
        serverPort = parseInt(serverPort.substr(1), 10);
    } else {
        serverTls = false;
        serverPort = parseInt(serverPort, 10);
    }

    this.state.addNetwork(serverAddr, nick, {
        server: serverAddr,
        port: serverPort,
        tls: serverTls,
        password: serverPassword,
    });
};
