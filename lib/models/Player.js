'use strict';
const url = require('url');
const Subscriber = require('../Subscriber');
const soap = require('../helpers/soap');
const TYPE = soap.TYPE;

const EMPTY_STATE = Object.freeze({
  currentTrack: Object.freeze({
    artist: '',
    title: '',
    album: '',
    albumArtUri: '',
    duration: 0,
    uri: '',
    radioShowMetaData: ''
  }),
  nextTrack: Object.freeze({
    artist: '',
    title: '',
    album: '',
    albumArtUri: '',
    duration: 0,
    uri: ''
  }),
  playMode: Object.freeze({
    repeat: false,
    shuffle: false,
    crossfade: false
  }),
  relTime: 0,
  stateTime: 0,
  volume: 0,
  mute: false,
  trackNo: 0,
  currentState: 'STOPPED'
});

const PLAY_MODE = Object.freeze({
  NORMAL: 0,
  REPEAT: 1,
  SHUFFLE_NOREPEAT: 2,
  SHUFFLE: 3,
  REPEAT_ONE: 4,
  SHUFFLE_REPEAT_ONE: 6
});

function reversePlayMode() {
  let lookup = {};
  for (let key in PLAY_MODE) {
    lookup[PLAY_MODE[key]] = key;
  }

  return lookup;
}

const PLAY_MODE_LOOKUP = Object.freeze(reversePlayMode());

function getPlayMode(state) {
  let key = state.shuffle << 1 | state.repeat;
  return PLAY_MODE_LOOKUP[key];
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function parseTime(formattedTime) {
  var chunks = formattedTime.split(':').reverse();
  var timeInSeconds = 0;

  for (var i = 0; i < chunks.length; i++) {
    timeInSeconds += parseInt(chunks[i], 10) * Math.pow(60, i);
  }

  return isNaN(timeInSeconds) ? 0 : timeInSeconds;
}

function zpad(number) {
  return number.toLocaleString('en-us', { minimumIntegerDigits: 2 });
}

function formatTime(seconds) {
  var chunks = [];
  var remainingTime = seconds;

  // hours
  var hours = Math.floor(remainingTime / 3600);

  chunks.push(zpad(hours));
  remainingTime -= hours * 3600;

  // minutes
  var minutes = Math.floor(remainingTime / 60);
  chunks.push(zpad(minutes));
  remainingTime -= minutes * 60;

  // seconds
  chunks.push(zpad(remainingTime));

  return chunks.join(':');
}

function parseTrackMetadata(metadata, nextTrack) {
  let track = nextTrack ? clone(EMPTY_STATE.nextTrack) : clone(EMPTY_STATE.currentTrack);
  track.uri = metadata.res.$text;
  track.duration = parseTime(metadata.res.$attrs.duration);
  track.artist = metadata['dc:creator'];
  track.album = metadata['upnp:album'];
  track.title = metadata['dc:title'];
  track.albumArtUri = metadata['upnp:albumarturi'];
  return track;
}

function Player(data, listener) {
  let _this = this;
  _this.roomName = data.zonename;
  _this.uuid = data.uuid;
  _this.state = clone(EMPTY_STATE);
  _this.ownVolumeEvents = [];

  let uri = url.parse(data.location);
  _this.baseUrl = `${uri.protocol}//${uri.host}`;

  let subscribeEndpoints = [
    '/MediaRenderer/AVTransport/Event',
    '/MediaRenderer/RenderingControl/Event',
    '/MediaRenderer/GroupRenderingControl/Event'
  ];

  let subscriptions = subscribeEndpoints.map((path) => {
    return new Subscriber(_this.baseUrl + path, listener.endpoint());
  });

  _this.dispose = function dispose() {
    subscriptions.forEach((subscriber) => {
      subscriber.dispose();
    });
  };

  function notificationHandler(uuid, data) {
    if (uuid !== _this.uuid) {
      // This was not intended for us, skip it.
      return;
    }

    if (data.transportstate) {
      _this.state.currentState = data.transportstate.val;
      _this.state.trackNo = parseInt(data.currenttrack.val);
      _this.state.currentTrack = parseTrackMetadata(data.currenttrackmetadata.item);
      _this.state.nextTrack = parseTrackMetadata(
        data.currenttrackmetadata['r:nexttrackmetadata'].item,
        true
      );
      _this.state.playMode.crossfade = data.currentcrossfademode.val === '1';

      // bitwise check if shuffle or repeat. Return boolean if flag is set.
      _this.state.playMode.repeat = !!(PLAY_MODE[data.currentplaymode.val] & PLAY_MODE.REPEAT);
      _this.state.playMode.shuffle = !!(PLAY_MODE[data.currentplaymode.val] & PLAY_MODE.SHUFFLE);

    } else if (data.volume) {
      let master = data.volume.find(x => x.channel === 'Master');
      _this.state.volume = parseInt(master.val);
    }

  }

  listener.on('last-change', notificationHandler);
}

Player.prototype.play = function play() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Play);
};

Player.prototype.pause = function pause() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Pause);
};

Player.prototype.nextTrack = function nextTrack() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Next);
};

Player.prototype.previousTrack = function previousTrack() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Previous);
};

Player.prototype.mute = function mute() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/RenderingControl/Control`,
    TYPE.Mute,
    { mute: 1 });
};

Player.prototype.unMute = function unMute() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/RenderingControl/Control`,
    TYPE.Mute,
    { mute: 0 });
};

Player.prototype.setVolume = function setVolume(level) {
  // If prefixed with + or -
  if (/^[+\-]/.test(level)) {
    level = this.state.volume + parseInt(level);
  }

  if (level < 0) level = 0;
  this.state.volume = level;

  // stash this update to ignore the event when it comes back.
  this.ownVolumeEvents.push(level);

  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/RenderingControl/Control`,
    TYPE.Volume,
    { volume: level });
};

Player.prototype.timeSeek = function timeSeek(seconds) {
  let formattedTime = formatTime(seconds);
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Seek,
    { unit: 'REL_TIME', value: formattedTime });
};

Player.prototype.trackSeek = function trackSeek(trackNo) {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.Seek,
    { unit: 'TRACK_NR', value: trackNo });
};

Player.prototype.clearQueue = function clearQueue() {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.RemoveAllTracksFromQueue);
};

Player.prototype.removeTrackFromQueue = function removeTrackFromQueue(index) {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.RemoveTrackFromQueue,
    { track: index || 0 });
};

Player.prototype.repeat = function repeat(enabled) {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.SetPlayMode,
    {
      playMode: getPlayMode({
        repeat: !!enabled,
        shuffle: this.state.playMode.shuffle
      })
    });
};

Player.prototype.shuffle = function shuffle(enabled) {
  return soap.invoke(
    `${this.baseUrl}/MediaRenderer/AVTransport/Control`,
    TYPE.SetPlayMode,
    {
      playMode: getPlayMode({
        shuffle: !!enabled,
        repeat: this.state.playMode.repeat
      })
    });
};

module.exports = Player;