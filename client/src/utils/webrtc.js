export const initWebRTC = async ({
                                     videoEnabled,
                                     audioEnabled,
                                     selectedVideoDevice,
                                     selectedAudioDevice,
                                     setLocalStream,
                                     localVideoRef,
                                     setError
                                 }) => {
    try {
        const shouldRequestVideo = videoEnabled && selectedVideoDevice;
        const shouldRequestAudio = audioEnabled && selectedAudioDevice;

        if (!shouldRequestVideo && !shouldRequestAudio) {
            throw new Error('Должно быть включено хотя бы одно устройство');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            video: shouldRequestVideo ? { deviceId: selectedVideoDevice } : false,
            audio: shouldRequestAudio ? { deviceId: selectedAudioDevice } : true
        });

        setLocalStream(stream);
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
        }
    } catch (err) {
        console.error('Ошибка доступа к медиаустройствам:', err);
        setError('Ошибка доступа к камере/микрофону. Проверьте разрешения.');
    }
};

export const toggleMedia = async ({
                                      type,
                                      enabledState,
                                      allowType,
                                      isCreator,
                                      roomId,
                                      peerId,
                                      wsRef,
                                      localStream,
                                      initWebRTC,
                                      setError
                                  }) => {
    if (!allowType && !isCreator) {
        setError(`${type === 'video' ? 'Видео' : 'Аудио'} запрещено в этой комнате`);
        return false;
    }

    const newState = !enabledState;

    if (wsRef.current) {
        const jsonRpc = new JsonRpc(wsRef.current);
        await jsonRpc.call('toggleMedia', {
            roomId,
            peerId,
            type,
            enabled: newState
        });
    }

    if (localStream) {
        const tracks = type === 'video'
            ? localStream.getVideoTracks()
            : localStream.getAudioTracks();
        tracks.forEach(track => (track.enabled = newState));
    } else if (newState) {
        await initWebRTC();
    }

    return newState;
};

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
}