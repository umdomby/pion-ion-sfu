import React, { useState, useEffect, useRef } from 'react';
import { VideoOnIcon, VideoOffIcon, MicOnIcon, MicOffIcon, SendIcon } from './components/Icons';
import SimplePeer from 'simple-peer';
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
    const peersRef = useRef({});
    const chatRef = useRef(null);

    useEffect(() => {
        // Generate a random peer ID
        setPeerId(Math.random().toString(36).substring(2, 10));

        // Get available media devices
        navigator.mediaDevices.enumerateDevices()
            .then(devices => {
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                const audioDevices = devices.filter(d => d.kind === 'audioinput');

                setAvailableDevices({
                    video: videoDevices,
                    audio: audioDevices
                });

                if (videoDevices.length > 0) {
                    setSelectedVideoDevice(videoDevices[0].deviceId);
                }
                if (audioDevices.length > 0) {
                    setSelectedAudioDevice(audioDevices[0].deviceId);
                }
            })
            .catch(err => {
                console.error('Error getting devices:', err);
                setError('Failed to get device list');
            });
    }, []);

    useEffect(() => {
        if (chatRef.current) {
            chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
    }, [messages]);

    const initWebRTC = async () => {
        try {
            const constraints = {
                video: videoEnabled ? { deviceId: selectedVideoDevice } : false,
                audio: audioEnabled ? { deviceId: selectedAudioDevice } : false
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setLocalStream(stream);

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }

            // Update all existing peers with the new stream
            Object.values(peersRef.current).forEach(peer => {
                if (stream) {
                    peer.addStream(stream);
                }
            });
        } catch (err) {
            console.error('WebRTC error:', err);
            setError(err.message);
        }
    };

    const createRoom = () => {
        if (!roomId || !nickname) {
            setError('Room ID and nickname are required');
            return;
        }

        wsRef.current = new WebSocket(`ws://${window.location.hostname}:8080/ws`);
        wsRef.current.onopen = () => {
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'createRoom',
                params: {
                    roomId: roomId,
                    password: password,
                    nickname: nickname,
                    fullControl: fullControl,
                    allowVideo: allowVideo,
                    allowAudio: allowAudio
                }
            };

            wsRef.current.send(JSON.stringify(request));

            wsRef.current.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.id === 1) {
                    // Room created response
                    setIsCreator(true);
                    setStep('room');
                    initWebRTC();
                } else if (data.method === 'newParticipant') {
                    // New participant joined
                    setParticipants(prev => [...prev, data.params]);
                    createPeer(data.params.peerId, false);
                } else if (data.method === 'participantLeft') {
                    // Participant left
                    setParticipants(prev => prev.filter(p => p.peerId !== data.params.peerId));
                    removePeer(data.params.peerId);
                } else if (data.method === 'newMessage') {
                    // New chat message
                    setMessages(prev => [...prev, data.params]);
                } else if (data.method === 'roomSettingsUpdated') {
                    // Room settings changed
                    setAllowVideo(data.params.allowVideo);
                    setAllowAudio(data.params.allowAudio);
                } else if (data.method === 'mediaChanged') {
                    // Participant media changed
                    setParticipants(prev =>
                        prev.map(p =>
                            p.peerId === data.params.peerId
                                ? { ...p, [data.params.type]: data.params.enabled }
                                : p
                        )
                    );
                } else if (data.method === 'signal') {
                    // WebRTC signal received
                    const peer = peersRef.current[data.params.PeerID];
                    if (peer) {
                        peer.signal(data.params.Payload);
                    }
                }
            };
        };
    };

    const joinRoom = () => {
        if (!roomId || !nickname) {
            setError('Room ID and nickname are required');
            return;
        }

        wsRef.current = new WebSocket(`ws://${window.location.hostname}:8080/ws`);
        wsRef.current.onopen = () => {
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'joinRoom',
                params: {
                    roomId: roomId,
                    password: password,
                    nickname: nickname,
                    peerId: peerId,
                    video: videoEnabled,
                    audio: audioEnabled
                }
            };

            wsRef.current.send(JSON.stringify(request));

            wsRef.current.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.id === 1) {
                    // Join room response
                    setAllowVideo(data.result.allowVideo);
                    setAllowAudio(data.result.allowAudio);
                    setFullControl(data.result.fullControl);
                    setStep('room');
                    setMessages(data.result.chatHistory || []);
                    setParticipants(data.result.participants || []);
                    initWebRTC();

                    // Create peers for existing participants
                    data.result.participants.forEach(participant => {
                        createPeer(participant.peerId, true);
                    });
                } else if (data.method === 'newParticipant') {
                    // New participant joined
                    setParticipants(prev => [...prev, data.params]);
                    createPeer(data.params.peerId, false);
                } else if (data.method === 'participantLeft') {
                    // Participant left
                    setParticipants(prev => prev.filter(p => p.peerId !== data.params.peerId));
                    removePeer(data.params.peerId);
                } else if (data.method === 'newMessage') {
                    // New chat message
                    setMessages(prev => [...prev, data.params]);
                } else if (data.method === 'roomSettingsUpdated') {
                    // Room settings changed
                    setAllowVideo(data.params.allowVideo);
                    setAllowAudio(data.params.allowAudio);
                } else if (data.method === 'mediaChanged') {
                    // Participant media changed
                    setParticipants(prev =>
                        prev.map(p =>
                            p.peerId === data.params.peerId
                                ? { ...p, [data.params.type]: data.params.enabled }
                                : p
                        )
                    );
                } else if (data.method === 'signal') {
                    // WebRTC signal received
                    const peer = peersRef.current[data.params.PeerID];
                    if (peer) {
                        peer.signal(data.params.Payload);
                    }
                }
            };
        };
    };

    const createPeer = (targetPeerId, initiator) => {
        if (peersRef.current[targetPeerId]) return;

        const peer = new SimplePeer({
            initiator,
            trickle: true,
            stream: localStream
        });

        peer.on('signal', data => {
            // Send the signaling data to the other peer via the server
            wsRef.current.send(JSON.stringify({
                jsonrpc: '2.0',
                method: 'signal',
                params: {
                    PeerID: targetPeerId,
                    Type: 'signal',
                    Payload: JSON.stringify(data)
                }
            }));
        });

        peer.on('stream', stream => {
            // Got remote video stream
            setRemoteStreams(prev => ({
                ...prev,
                [targetPeerId]: stream
            }));
        });

        peer.on('close', () => {
            removePeer(targetPeerId);
        });

        peer.on('error', err => {
            console.error('Peer error:', err);
            removePeer(targetPeerId);
        });

        peersRef.current[targetPeerId] = peer;
    };

    const removePeer = (peerId) => {
        if (peersRef.current[peerId]) {
            peersRef.current[peerId].destroy();
            delete peersRef.current[peerId];
        }

        setRemoteStreams(prev => {
            const newStreams = { ...prev };
            delete newStreams[peerId];
            return newStreams;
        });
    };

    const updateRoomSettings = () => {
        if (!isCreator) return;

        wsRef.current.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'updateSettings',
            params: {
                roomId: roomId,
                allowVideo: allowVideo,
                allowAudio: allowAudio
            }
        }));
    };

    const sendMessage = () => {
        if (!message.trim()) return;

        wsRef.current.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'sendMessage',
            params: {
                roomId: roomId,
                peerId: peerId,
                nickname: nickname,
                message: message
            }
        }));

        setMessage('');
    };

    const toggleMedia = async (type) => {
        const currentState = type === 'video' ? videoEnabled : audioEnabled;
        const newState = !currentState;

        // Check permissions if not creator
        if (!isCreator) {
            if (type === 'video' && !allowVideo) {
                setError('Video is not allowed in this room');
                return;
            }
            if (type === 'audio' && !allowAudio) {
                setError('Audio is not allowed in this room');
                return;
            }
        }

        // Update state
        if (type === 'video') {
            setVideoEnabled(newState);
        } else {
            setAudioEnabled(newState);
        }

        // Send update to server
        wsRef.current.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'toggleMedia',
            params: {
                roomId: roomId,
                peerId: peerId,
                type: type,
                enabled: newState
            }
        }));

        // Reinitialize media if enabling
        if (newState) {
            await initWebRTC();
        } else if (localStream) {
            // Disable the tracks if disabling
            const tracks = type === 'video'
                ? localStream.getVideoTracks()
                : localStream.getAudioTracks();
            tracks.forEach(track => track.enabled = false);
        }
    };

    const leaveRoom = () => {
        if (wsRef.current) {
            wsRef.current.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 5,
                method: 'leaveRoom',
                params: {
                    roomId: roomId,
                    peerId: peerId
                }
            }));

            // Clean up
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                setLocalStream(null);
            }

            Object.keys(peersRef.current).forEach(peerId => {
                removePeer(peerId);
            });

            wsRef.current.close();
            setStep('createOrJoin');
            setRemoteStreams({});
            setParticipants([]);
            setMessages([]);
        }
    };

    const formatTime = (dateString) => {
        if (typeof dateString === 'string') {
            return new Date(dateString).toLocaleTimeString();
        }
        return dateString.toLocaleTimeString();
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
                            disabled={availableDevices.video.length === 0}
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
                            disabled={availableDevices.audio.length === 0}
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
                                            disabled={!allowVideo && !isCreator}
                                        >
                                            {videoEnabled ? <VideoOnIcon /> : <VideoOffIcon />}
                                        </button>
                                        <button
                                            onClick={() => toggleMedia('audio')}
                                            className={`media-btn ${audioEnabled ? 'active' : ''}`}
                                            disabled={!allowAudio && !isCreator}
                                        >
                                            {audioEnabled ? <MicOnIcon /> : <MicOffIcon />}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {participants.map(participant => (
                                <div key={participant.peerId} className="video-item remote">
                                    <video
                                        ref={el => {
                                            if (el && remoteStreams[participant.peerId]) {
                                                el.srcObject = remoteStreams[participant.peerId];
                                            }
                                        }}
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

export default App;