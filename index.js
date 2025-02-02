const config = require('nconf')
const winston = require('winston')
const decode = require('unescape');
const Spotify = require('./spotify')
const utils = require('./utils')

config.argv()
  .env()
  .file({ file: 'config.json' })
  .defaults({
    'searchLimit': 5,
    'logLevel': 'info',
  })

const adminChannel = config.get('adminChannel')
const token = config.get('token')
const market = config.get('market')
const clientId = config.get('spotifyClientId')
const clientSecret = config.get('spotifyClientSecret')
const searchLimit = config.get('searchLimit')
const logLevel = config.get('logLevel')

/* Initialize Logger */
const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [
        new winston.transports.Console({format: winston.format.combine(winston.format.colorize(), winston.format.simple())})
    ]
});

/* Initialize Sonos */
const SONOS = require('sonos')
const Sonos = SONOS.Sonos
const speakers = config.get('sonos').map((speaker) => new Sonos(speaker));
const sonos = speakers[0];

/* Initialize Spotify instance */
const spotify = Spotify({clientId: clientId, clientSecret: clientSecret, market: 'US', logger: logger})

const RtmClient = require('@slack/client').RtmClient
const RTM_EVENTS = require('@slack/client').RTM_EVENTS
const MemoryDataStore = require('@slack/client').MemoryDataStore

let slack = new RtmClient(token, {
  logLevel: 'error',
  dataStore: new MemoryDataStore(),
  autoReconnect: true,
  autoMark: true
})

/* Slack handlers */
slack.on('open', function () {
  var channel, group, id
  channels = (function () {
    var _ref, _results
    _ref = slack.channels
    _results = []
    for (id in _ref) {
      channel = _ref[id]
      if (channel.is_member) {
        _results.push('#' + channel.name)
      }
    }
    return _results
  })()

  groups = (function () {
    var _ref, _results
    _ref = slack.groups
    _results = []
    for (id in _ref) {
      group = _ref[id]
      if (group.is_open && !group.is_archived) {
        _results.push(group.name)
      }
    }
    return _results
  })()
  logger.info('Online!')
})

slack.on(RTM_EVENTS.MESSAGE, (message) => {
    let channel, channelError, channelName, errors, response, text, textError, ts, type, typeError, user, userName

    channel = slack.dataStore.getChannelGroupOrDMById(message.channel)
    type = message.type, ts = message.ts, text = decode(message.text)
    channelName = (channel != null ? channel.is_channel : void 0) ? '#' : ''
    channelName = channelName + (channel ? channel.name : 'UNKNOWN_CHANNEL')
    userName = '<@' + message.user + '>'
    logger.info('Received: ' + type + ' ' + channelName + ' ' + userName + ' ' + ts + ' "' + text + '"')

    user = slack.dataStore.getUserById(message.user)

    if (user && user.is_bot) {
        _slackMessage('Sorry ' + userName + ', no bots allowed!', channel.id)
    }

    if (type !== 'message' || (text == null) || (channel == null)) {
        typeError = type !== 'message' ? 'unexpected type ' + type + '.' : null
        textError = text == null ? 'text was undefined.' : null
        channelError = channel == null ? 'channel was undefined.' : null
        errors = [typeError, textError, channelError].filter(function (element) {
            return element !== null
        }).join(' ')

        logger.error('Could not respond. ' + errors)
        return false
    }

    processInput(text, channel, userName)
})

slack.on('error', function (error) {
  logger.error('Error: ' + error)
})

/* Expose cli or Connect to Slack */
if (process.argv.length > 2) {
  processInput(process.argv.slice(2).join(' '), {name: adminChannel}, 'cli test')
} else {
  slack.start()
}

function processInput(text, channel, userName) {
    var input = text.split(' ')
    var term = input[0].toLowerCase()
    var matched = true
    logger.info('term: ' + term)

    switch (term) {
        case 'add':
            _add(input, channel, userName)
            break
        case 'search':
            _search(input, channel, userName)
            break
        case 'current':
            _currentTrack(channel)
            break
        case 'list':
            _showQueue(channel)
            break
        case 'upnext':
            _upNext(channel)
            break
        case 'help':
            _help(input, channel)
            break
        default:
            matched = false
            break
    }

    if (!matched && channel.name === adminChannel) {
        switch (term) {
            case 'next':
                _nextTrack(channel)
                break
            case 'stop':
                _stop(input, channel)
                break
            case 'flush':
                _flush(input, channel)
                break
            case 'play':
                _play(input, channel)
                break
            case 'pause':
                _pause(input, channel)
                break
            case 'resume':
                _resume(input, channel)
                break
            case 'previous':
                _previous(input, channel)
                break
            case 'remove':
                _removeTrack(input, channel)
                break
            default:
                break
        }
    }
}

function _slackMessage (message, id) {
  if (slack.connected) {
      slack.sendMessage(message, id)
  } else {
      console.log(message)
  }
}

function _showQueue (channel) {
  sonos.getQueue().then(result => {
    logger.info('Current queue: ' + JSON.stringify(result, null, 2))
    _status(channel, function (state) {
      logger.info('_showQueue, got state = ' + state)
    })
    _currentTrack(channel, function (err, track) {
      if (!result) {
        logger.debug(result)
        _slackMessage('Seems like the queue is empty... Have you tried adding a song?!', channel.id)
      }
      if (err) {
        logger.error(err)
      }
      var message = 'Total tracks in queue: ' + result.total + '\n====================\n'
      let tracks = []

      result.items.map(
        function (item, i) {
          if (item['title'] === track.title) {
            tracks.push(':notes: ' + '_#' + i + '_ ' + item['title'] + ' by ' + item['artist'])
          } else {
            tracks.push('>_#' + i + '_ ' + item['title'] + ' by ' + item['artist'])
          }
        }
      )
      for (var i in tracks) {
          message += tracks[i] + "\n"
          if (i > 0 && Math.floor(i % 100) == 0) {
              _slackMessage(message, channel.id)
              message = ''
          }
      }
      if (message) {
          _slackMessage(message, channel.id)
      }
    })
  }).catch(err => {
    logger.error('Error fetch queue: ' + err)
  })
}

function _upNext (channel) {
    sonos.getQueue().then(result => {
        logger.debug('Current queue: ' + JSON.stringify(result, null, 2))

        _currentTrack(channel, function (err, track) {
            if (!result) {
                logger.debug(result)
                _slackMessage('Seems like the queue is empty... Have you tried adding a song?!', channel.id)
            }
            if (err) {
                logger.error(err)
            }
            var message = 'Recent and upcoming tracks\n====================\n'
            let tracks = []
            let currentIndex = track.queuePosition
            result.items.map(
                function (item, i) {
                    if (i === currentIndex) {
                        currentIndex = i
                        tracks.push(':notes: ' + '_#' + i + '_ ' + item['title'] + ' by ' + item['artist'])
                    } else {
                        tracks.push('>_#' + i + '_ ' + item['title'] + ' by ' + item['artist'])
                    }
                }
            )
            tracks = tracks.slice(Math.max(currentIndex - 5, 0), Math.min(currentIndex + 20, tracks.length))
            for (var i in tracks) {
                message += tracks[i] + "\n"
            }
            if (message) {
                _slackMessage(message, channel.id)
            }
        })
    }).catch(err => {
        logger.error('Error fetching queue: ' + err)
    })
}

function _previous (input, channel) {
  if (channel.name !== adminChannel) {
    return
  }

  speakers.forEach((speaker) => {
    speaker.previous(function (err, previous) {
      logger.error(`speaker ${speaker.ip} had error: ${err} ${previous}`);
    });
  });
}

function _help (input, channel) {
  var message = 'Current commands!\n' +
        ' ===  ===  ===  ===  ===  ===  === \n' +
        '`add` _text_ : Add song to the queue and start playing if idle. Will start with a fresh queue.\n' +
        '`current` : list current track\n' +
        '`search` _text_ : search for a track, does NOT add it to the queue\n' +
        '`list` : list current queue\n'

  if (channel.name === adminChannel) {
    message += '------ ADMIN FUNCTIONS ------\n' +
            '`flush` : flush the current queue\n' +
            '`play` : play track\n' +
            '`stop` : stop life\n' +
            '`pause` : pause life\n' +
            '`resume` : resume after pause\n' +
            '`next` : play next track\n' +
            '`previous` : play previous track\n'
  }
  message += ' ===  ===  ===  ===  ===  ===  === \n'
  _slackMessage(message, channel.id)
}

function _play (input, channel, state) {
  if (channel.name !== adminChannel) {
    return
  }

  speakers.forEach((speaker) => {
    speaker.selectQueue();
    speaker.play().then(result => {
      logger.info(`speaker ${speaker.ip} started playing - ${result}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })

  _status(channel, state);
}

function _playInt (input, channel) {
  speakers.forEach((speaker) => {
    speaker.selectQueue();
    speaker.play().then(result => {
      logger.info(`speaker ${speaker.ip} playInt started playing` + result)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })
}

function _stop (input, channel, state) {
  if (channel.name !== adminChannel) {
    return
  }

  speakers.forEach((speaker) => {
    speaker.stop().then(result => {
      logger.info(`speaker ${speaker.ip} stoped playing - ${result}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })

  _status(channel, state)
}

function _pause (input, channel, state) {
  if (channel.name !== adminChannel) {
    return
  }

  speakers.forEach((speaker) => {
    speaker.pause().then(result => {
      logger.info(`speaker ${speaker.ip} pause playing - ${result}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })

  _status(channel, state)
}

function _resume (input, channel, state) {
  if (channel.name !== adminChannel) {
    return
  }

  speakers.forEach((speaker) => {
    speaker.play().then(result => {
      logger.info(`speaker ${speaker.ip} resume playing - ${result}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  });

  setTimeout(() => _status(channel, state), 500)
}

function _flush (input, channel) {
  if (channel.name !== adminChannel) {
    return
  }

  speaker.forEach((speaker) => {
    speaker.flush().then(result => {
      logger.info(`speaker ${speaker.ip} flushed queue: ${JSON.stringify(result, null, 2)}`)
    }).catch(err => {
      logger.error(`speaker ${speaker.ip} had error: ${err}`)
    })
  })

  _slackMessage('Sonos queue is clear.', channel.id)
}

function _removeTrack (input, channel) {
  if (channel.name !== adminChannel) {
    return
  }

  var trackNb = parseInt(input[1]) + 1;

  speaker.forEach((speaker) => {
    speaker.removeTracksFromQueue(trackNb, 1).then(success => {
        logger.info(`speaker ${speaker.ip} removed track with index: ${trackNb}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })

  _slackMessage(`Removed track with index ${input[1]}`, channel.id)
}

function _nextTrack (channel) {
  if (channel.name !== adminChannel) {
    return
  }

  speaker.forEach((speaker) => {
    sonos.next().then(success => {
      logger.info(`speaker ${speaker.ip} _nextTrack > Playing Next track.. `)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`) })
  })
}

function _currentTrack (channel, cb, err) {
  sonos.currentTrack().then(track => {
    logger.info('Got current track: ' + track)
    if (err) {
      logger.error(err + ' ' + track)
      if (cb) {
        return cb(err, null)
      }
    } else {
      if (cb) {
        return cb(null, track)
      }

      logger.info(track)
      var fmin = '' + Math.floor(track.duration / 60)
      fmin = fmin.length === 2 ? fmin : '0' + fmin
      var fsec = '' + track.duration % 60
      fsec = fsec.length === 2 ? fsec : '0' + fsec

      var pmin = '' + Math.floor(track.position / 60)
      pmin = pmin.length === 2 ? pmin : '0' + pmin
      var psec = '' + track.position % 60
      psec = psec.length === 2 ? psec : '0' + psec

      var message = `We're rocking out to *${track.artist}* - *${track.title}* (${pmin}:${psec}/${fmin}:${fsec})`
      _slackMessage(message, channel.id)
    }
  }).catch(err => { logger.error('Error occurred ' + err) })
}

function _add (input, channel, userName) {
  var [data, message] = spotify.searchSpotify(input, channel, userName, 1)
  if (message) {
    _slackMessage(message, channel.id)
  }
  if (!data) {
    return
  }

  var uri = data.tracks.items[0].uri
  var albumImg = data.tracks.items[0].album.images[2].url
  var trackName = data.tracks.items[0].artists[0].name + ' - ' + data.tracks.items[0].name

  logger.info('Adding track:' + trackName + ' with UID: ' + uri)

  sonos.getCurrentState().then(state => {
    logger.info('Got current state: ' + state)

    if (state === 'stopped') {
sonos.flush().then(result => {
    logger.info('Flushed queue: ' + JSON.stringify(result, null, 2))

      logger.info('State: ' + state + ' - flushing')
      _addToSpotify(userName, uri, albumImg, trackName, channel)
      logger.info('Adding track:' + trackName)
      setTimeout(() => _playInt('play', channel), 500)

  }).catch(err => {
    logger.error('Error flushing queue: ' + err)
  })
    } else if (state === 'playing') {
      logger.info('State: ' + state + ' - playing...')
      // Add the track to playlist...
      _addToSpotify(userName, uri, albumImg, trackName, channel)
    } else if (state === 'paused') {
      logger.info('State: ' + state +' - telling them no...')
      _addToSpotify(userName, uri, albumImg, trackName, channel, function () {
        if (channel.name === adminChannel) {
          _slackMessage('Sonos is currently PAUSED. Type `resume` to start playing...', channel.id)
        }
      })
    } else if (state === 'transitioning') {
      logger.info('State: ' + state + ' - no idea what to do')

      _slackMessage("Sonos says it is 'transitioning'. We've got no idea what that means either...", channel.id)
    } else if (state === 'no_media') {
      _slackMessage("Sonos reports 'no media'. Any idea what that means?", channel.id)
    } else {
      _slackMessage("Sonos reports its state as '" + state + "'. Any idea what that means? I've got nothing.", channel.id)
    }
  }).catch(err => { logger.error('Error occurred' + err) })
}

function _search (input, channel, userName) {
  logger.info('_search '+ input)
  var [data, message] = spotify.searchSpotify(input, channel, userName, searchLimit)

  if (message) {
    _slackMessage(message, channel.id)
  }
  if (!data) {
    return
  }

  var trackNames = []
  for (var i = 1; i <= data.tracks.items.length; i++) {
    var trackName = data.tracks.items[i - 1].artists[0].name + ' - ' + data.tracks.items[i - 1].name
    trackNames.push(trackName)
  }

  // Print the result...
  message = userName +
        ', I found the following track(s):\n```\n' +
        trackNames.join('\n') +
        '\n```\nIf you want to play it, use the `add` command..\n'

  _slackMessage(message, channel.id)
}

// FIXME - misnamed s/ add to sonos, appears funcionally identical to _addToSpotifyPlaylist
function _addToSpotify (userName, uri, albumImg, trackName, channel, cb) {
  logger.info('_addToSpotify '+ uri)
  sonos.queue(uri).then(result => {
    logger.info('Queued the following: ' + result)

    logger.info('queue:')
    var queueLength = result.FirstTrackNumberEnqueued
    logger.info('queueLength' + queueLength)
    var message = 'Sure ' +
            userName +
            ', Added ' +
             trackName +
            ' to the queue!\n' +
            albumImg +
            '\nPosition in queue is ' +
            queueLength

    _slackMessage(message, channel.id)
  }).catch(err => {
    _slackMessage('Error! No spotify account?', channel.id)
    logger.error('Error occurred: ' + err)
  })
}

function _status (channel, state) {
  speakers.forEach((speaker) => {
    speaker.getCurrentState().then(state => {
      logger.info(`speaker ${speaker.ip} current state: ${state}`)
    }).catch(err => { logger.error(`speaker ${speaker.ip} had error: ${err}`)})
  })

  _slackMessage(`Sonos state is '${state}'`, channel.id)
}

module.exports = function (number, locale) {
  return number.toLocaleString(locale)
}
