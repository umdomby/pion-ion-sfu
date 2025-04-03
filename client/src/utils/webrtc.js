export const initWebRTC = async ({
                                     videoEnabled,
                                     audioEnabled,
                                     selectedVideoDevice,
                                     selectedAudioDevice,
                                     setLocalStream,
                                     localVideoRef,
                                     setError,
                                     setAvailableDevices,
                                     setSelectedVideoDevice,
                                     setSelectedAudioDevice
                                 }) => {
    try {
        // Сначала запросим доступ к устройствам без ограничений, чтобы получить список
        const allDevices = await navigator.mediaDevices.enumerateDevices();

        const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
        const audioDevices = allDevices.filter(d => d.kind === 'audioinput');

        setAvailableDevices({
            video: videoDevices,
            audio: audioDevices
        });

        // Установим дефолтные устройства, если они не выбраны
        const videoDeviceId = selectedVideoDevice || (videoDevices[0]?.deviceId || null);
        const audioDeviceId = selectedAudioDevice || (audioDevices[0]?.deviceId || null);

        if (videoDeviceId) setSelectedVideoDevice(videoDeviceId);
        if (audioDeviceId) setSelectedAudioDevice(audioDeviceId);

        // Теперь запросим медиапоток с выбранными устройствами
        const constraints = {
            video: videoEnabled ? {
                deviceId: videoDeviceId ? { exact: videoDeviceId } : true
            } : false,
            audio: audioEnabled ? {
                deviceId: audioDeviceId ? { exact: audioDeviceId } : true
            } : false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        setLocalStream(stream);
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
        }

        // Обновим список устройств после получения доступа (чтобы получить названия)
        const updatedDevices = await navigator.mediaDevices.enumerateDevices();
        const updatedVideoDevices = updatedDevices.filter(d => d.kind === 'videoinput');
        const updatedAudioDevices = updatedDevices.filter(d => d.kind === 'audioinput');

        setAvailableDevices({
            video: updatedVideoDevices,
            audio: updatedAudioDevices
        });

    } catch (err) {
        console.error('Ошибка доступа к медиаустройствам:', err);
        setError('Ошибка доступа к камере/микрофону. Проверьте разрешения.');
        throw err;
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
                                      setError,
                                      selectedVideoDevice,
                                      selectedAudioDevice
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

        if (tracks.length > 0) {
            tracks.forEach(track => (track.enabled = newState));
        } else if (newState) {
            // Если треков нет (например, устройство было отключено), переинициализируем
            await initWebRTC();
        }
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
            try {
                const data = JSON.parse(event.data);
                if (data.id && this.promises[data.id]) {
                    if (data.error) {
                        this.promises[data.id].reject(data.error);
                    } else {
                        this.promises[data.id].resolve(data.result);
                    }
                    delete this.promises[data.id];
                }
            } catch (err) {
                console.error('Error parsing JSON-RPC message:', err);
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