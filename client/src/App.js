import React, { useState, useEffect, useRef } from 'react';
import { ReactComponent as VideoOnIcon } from './icons/video-on.svg';
import { ReactComponent as VideoOffIcon } from './icons/video-off.svg';
import { ReactComponent as MicOnIcon } from './icons/mic-on.svg';
import { ReactComponent as MicOffIcon } from './icons/mic-off.svg';
import { ReactComponent as SendIcon } from './icons/send.svg';
import './App.css';

const App = () => {
    const [step, setStep] = useState('createOrJoin');
    const [roomId, setRoomId] = useState('');
    const [password, setPassword] = useState('');
    const [nickname, setNickname] = useState('');
    const [fullControl, setFullControl] = useState(false);
    const [allowVideo, setAllowVideo] = useState(true);
    const [allowAudio, setAllowAudio] = useState(true);
    const [isCreator, setIsCreator] = useState(false);
    const [peerId, setPeerId] = useState('');
    const [participants, setParticipants] = useState([]);
    const [messages, setMessages] = useState([]);
    const [message, setMessage] = useState('');
    const [videoEnabled, setVideoEnabled] = useState(false);
    const [audioEnabled, setAudioEnabled] = useState(false);
    const [availableDevices, setAvailableDevices] = useState({ video: [], audio: [] });
    const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
    const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
    const [localStream, setLocalStream] = useState(null);
    const [remoteStreams, setRemoteStreams] = useState({});
    const [error, setError] = useState('');

    const localVideoRef = useRef(null);
    const remoteVideosRef = useRef({});
    const wsRef = useRef(null);
    const pcRefs = useRef({});
    const chatRef = useRef(null);

    useEffect(() => {
        // Generate random peer ID
        setPeerId(Math.random().toString(36).substring(2, 10));

        // Get available devices
        navigator.mediaDevices.enumerateDevices()
            .then(devices => {
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                const audioDevices = devices.filter(d => d.kind === 'audioinput');
                setAvailableDevices({
                    video: videoDevices,
                    audio: audioDevices
                });
                if (videoDevices.length > 0) setSelectedVideoDevice(videoDevices[0].deviceId);
                if (audioDevices.length > 0) setSelectedAudioDevice(audioDevices[0].deviceId);
            });
    }, []);

    useEffect(() => {
        if (chatRef.current) {
            chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
    }, [messages]);

    const createRoom = () => {
        if (!roomId || !nickname) {
            setError('Room ID and nickname are required');
            return;
        }

        wsRef.current = new WebSocket(`ws://localhost:8080/ws`);
        wsRef.current.onopen = () => {
            const jsonRpc = new JsonRpc(wsRef.current);

            jsonRpc.call('createRoom', {
                roomId: roomId,
                password: password,
                nickname: nickname,
                fullControl: fullControl,
                allowVideo: allowVideo,
                allowAudio: allowAudio
            }).then(response => {
                setIsCreator(true);
                setStep('room');
                initWebRTC();
            }).catch(err => {
                setError(err.message);
            });
        };
    };

    const joinRoom = () => {
        if (!roomId || !nickname) {
            setError('Room ID and nickname are required');
            return;
        }

        wsRef.current = new WebSocket(`ws://${window.location.hostname}:8080/ws`);
        wsRef.current.onopen = () => {
            const jsonRpc = new JsonRpc(wsRef.current);

            jsonRpc.call('joinRoom', {
                roomId: roomId,
                password: password,
                nickname: nickname,
                peerId: peerId,
                video: videoEnabled,
                audio: audioEnabled
            }).then(response => {
                setAllowVideo(response.allowVideo);
                setAllowAudio(response.allowAudio);
                setFullControl(response.fullControl);
                setStep('room');
                setMessages(response.chatHistory || []);
                setParticipants(response.participants || []);
                initWebRTC();
            }).catch(err => {
                setError(err.message);
            });
        };

        wsRef.current.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.method === 'newParticipant') {
                setParticipants(prev => [...prev, data.params]);
            } else if (data.method === 'participantLeft') {
                setParticipants(prev => prev.filter(p => p.peerId !== data.params.peerId));
                removeRemoteStream(data.params.peerId);
            } else if (data.method === 'newMessage') {
                setMessages(prev => [...prev, data.params]);
            } else if (data.method === 'roomSettingsUpdated') {
                setAllowVideo(data.params.allowVideo);
                setAllowAudio(data.params.allowAudio);
            } else if (data.method === 'mediaChanged') {
                setParticipants(prev =>
                    prev.map(p =>
                        p.peerId === data.params.peerId
                            ? { ...p, [data.params.type]: data.params.enabled }
                            : p
                    )
                );
            }
        };
    };

    const initWebRTC = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: videoEnabled && selectedVideoDevice ? { deviceId: selectedVideoDevice } : false,
                audio: audioEnabled && selectedAudioDevice ? { deviceId: selectedAudioDevice } : false
            });

            setLocalStream(stream);
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }

            // Here you would normally initialize SFU connection
            // For simplicity, we're simulating it
        } catch (err) {
            console.error('Error getting media:', err);
        }
    };

    const toggleMedia = async (type) => {
        if (type === 'video') {
            if (!allowVideo && !isCreator) {
                setError('Video is not allowed in this room');
                return;
            }

            setVideoEnabled(!videoEnabled);

            if (wsRef.current) {
                const jsonRpc = new JsonRpc(wsRef.current);
                await jsonRpc.call('toggleMedia', {
                    roomId: roomId,
                    peerId: peerId,
                    type: 'video',
                    enabled: !videoEnabled
                });
            }

            if (localStream) {
                localStream.getVideoTracks().forEach(track => {
                    track.enabled = !videoEnabled;
                });
            } else if (!videoEnabled) {
                initWebRTC();
            }
        } else if (type === 'audio') {
            if (!allowAudio && !isCreator) {
                setError('Audio is not allowed in this room');
                return;
            }

            setAudioEnabled(!audioEnabled);

            if (wsRef.current) {
                const jsonRpc = new JsonRpc(wsRef.current);
                await jsonRpc.call('toggleMedia', {
                    roomId: roomId,
                    peerId: peerId,
                    type: 'audio',
                    enabled: !audioEnabled
                });
            }

            if (localStream) {
                localStream.getAudioTracks().forEach(track => {
                    track.enabled = !audioEnabled;
                });
            } else if (!audioEnabled) {
                initWebRTC();
            }
        }
    };

    const updateRoomSettings = () => {
        if (!isCreator) return;

        const jsonRpc = new JsonRpc(wsRef.current);
        jsonRpc.call('updateSettings', {
            roomId: roomId,
            allowVideo: allowVideo,
            allowAudio: allowAudio
        }).catch(err => {
            setError(err.message);
        });
    };

    const sendMessage = () => {
        if (!message.trim()) return;

        const jsonRpc = new JsonRpc(wsRef.current);
        jsonRpc.call('sendMessage', {
            roomId: roomId,
            peerId: peerId,
            nickname: nickname,
            message: message
        }).then(() => {
            setMessage('');
        }).catch(err => {
            setError(err.message);
        });
    };

    const leaveRoom = () => {
        if (wsRef.current) {
            const jsonRpc = new JsonRpc(wsRef.current);
            jsonRpc.call('leaveRoom', {
                roomId: roomId,
                peerId: peerId
            }).then(() => {
                if (localStream) {
                    localStream.getTracks().forEach(track => track.stop());
                }
                wsRef.current.close();
                setStep('createOrJoin');
                setRemoteStreams({});
            }).catch(err => {
                setError(err.message);
            });
        }
    };

    const addRemoteStream = (peerId, stream) => {
        setRemoteStreams(prev => ({ ...prev, [peerId]: stream }));
    };

    const removeRemoteStream = (peerId) => {
        setRemoteStreams(prev => {
            const newStreams = { ...prev };
            delete newStreams[peerId];
            return newStreams;
        });
    };

    const formatTime = (dateString) => {
        const date = new Date(dateString);
        return date.toLocaleTimeString();
    };

    return (
        <div className="app">
            {step === 'createOrJoin' && (
                <div className="create-join-container">
                    <h1>Video Conference</h1>
                    <div className="form-group">
                        <label>Nickname</label>
                        <input
                            type="text"
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            placeholder="Your nickname"
                        />
                    </div>
                    <div className="form-group">
                        <label>Room ID</label>
                        <input
                            type="text"
                            value={roomId}
                            onChange={(e) => setRoomId(e.target.value)}
                            placeholder="Room ID"
                        />
                    </div>
                    <div className="form-group">
                        <label>Password (optional)</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Room password"
                        />
                    </div>
                    <div className="form-group checkbox-group">
                        <label>
                            <input
                                type="checkbox"
                                checked={fullControl}
                                onChange={(e) => setFullControl(e.target.checked)}
                            />
                            Full control (creator only)
                        </label>
                    </div>
                    {fullControl && (
                        <>
                            <div className="form-group checkbox-group">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={allowVideo}
                                        onChange={(e) => setAllowVideo(e.target.checked)}
                                    />
                                    Allow participants to enable video
                                </label>
                            </div>
                            <div className="form-group checkbox-group">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={allowAudio}
                                        onChange={(e) => setAllowAudio(e.target.checked)}
                                    />
                                    Allow participants to enable audio
                                </label>
                            </div>
                        </>
                    )}
                    <div className="form-group">
                        <label>Video Device</label>
                        <select
                            value={selectedVideoDevice}
                            onChange={(e) => setSelectedVideoDevice(e.target.value)}
                        >
                            {availableDevices.video.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Camera ${availableDevices.video.indexOf(device) + 1}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Audio Device</label>
                        <select
                            value={selectedAudioDevice}
                            onChange={(e) => setSelectedAudioDevice(e.target.value)}
                        >
                            {availableDevices.audio.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Microphone ${availableDevices.audio.indexOf(device) + 1}`}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="button-group">
                        <button className="btn create-btn" onClick={createRoom}>Create Room</button>
                        <button className="btn join-btn" onClick={joinRoom}>Join Room</button>
                    </div>
                    {error && <div className="error-message">{error}</div>}
                </div>
            )}

            {step === 'room' && (
                <div className="room-container">
                    <div className="video-container">
                        <div className="participants-grid">
                            <div className="video-item local">
                                <video
                                    ref={localVideoRef}
                                    autoPlay
                                    playsInline
                                    muted
                                    className={videoEnabled ? '' : 'disabled'}
                                />
                                <div className="video-info">
                                    <span>{nickname} {isCreator && '(Creator)'}</span>
                                    <div className="media-controls">
                                        <button
                                            onClick={() => toggleMedia('video')}
                                            className={`media-btn ${videoEnabled ? 'active' : ''}`}
                                        >
                                            {videoEnabled ? <VideoOnIcon /> : <VideoOffIcon />}
                                        </button>
                                        <button
                                            onClick={() => toggleMedia('audio')}
                                            className={`media-btn ${audioEnabled ? 'active' : ''}`}
                                        >
                                            {audioEnabled ? <MicOnIcon /> : <MicOffIcon />}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {participants.map(participant => (
                                <div key={participant.peerId} className="video-item remote">
                                    <video
                                        ref={el => remoteVideosRef.current[participant.peerId] = el}
                                        autoPlay
                                        playsInline
                                        className={participant.video ? '' : 'disabled'}
                                    />
                                    <div className="video-info">
                                        <span>{participant.nickname} {participant.isCreator && '(Creator)'}</span>
                                        <div className="media-status">
                                            {participant.video ? <VideoOnIcon className="status-icon" /> : <VideoOffIcon className="status-icon" />}
                                            {participant.audio ? <MicOnIcon className="status-icon" /> : <MicOffIcon className="status-icon" />}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="sidebar">
                        <div className="room-info">
                            <h3>Room: {roomId}</h3>
                            <p>Participants: {participants.length + 1}</p>
                            {isCreator && (
                                <div className="room-settings">
                                    <h4>Room Settings</h4>
                                    <div className="checkbox-group">
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={allowVideo}
                                                onChange={(e) => {
                                                    setAllowVideo(e.target.checked);
                                                    updateRoomSettings();
                                                }}
                                            />
                                            Allow video
                                        </label>
                                    </div>
                                    <div className="checkbox-group">
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={allowAudio}
                                                onChange={(e) => {
                                                    setAllowAudio(e.target.checked);
                                                    updateRoomSettings();
                                                }}
                                            />
                                            Allow audio
                                        </label>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="chat-container" ref={chatRef}>
                            <div className="chat-messages">
                                {messages.map((msg, index) => (
                                    <div key={index} className="message">
                                        <div className="message-header">
                                            <span className="message-sender">{msg.nickname}</span>
                                            <span className="message-time">{formatTime(msg.timestamp)}</span>
                                        </div>
                                        <div className="message-text">{msg.message}</div>
                                    </div>
                                ))}
                            </div>
                            <div className="chat-input">
                                <input
                                    type="text"
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder="Type a message..."
                                    onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                                />
                                <button onClick={sendMessage}><SendIcon /></button>
                            </div>
                        </div>

                        <button className="btn leave-btn" onClick={leaveRoom}>Leave Room</button>
                    </div>
                </div>
            )}
        </div>
    );
};

// Simple JSON-RPC client
class JsonRpc {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.promises = {};

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.id && this.promises[data.id]) {
                if (data.error) {
                    this.promises[data.id].reject(data.error);
                } else {
                    this.promises[data.id].resolve(data.result);
                }
                delete this.promises[data.id];
            }
        };
    }

    call(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.id;
            this.promises[id] = { resolve, reject };

            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params
            }));
        });
    }

    notify(method, params) {
        this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method,
            params
        }));
    }
}

export default App;