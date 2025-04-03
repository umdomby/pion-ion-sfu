package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/ion-sfu/pkg/sfu"
	"github.com/sourcegraph/jsonrpc2"
	websocketjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
)

type Room struct {
	ID           string
	Password     string
	Creator      string
	FullControl  bool
	AllowVideo   bool
	AllowAudio   bool
	Participants map[string]*Participant
	mu           sync.RWMutex
}

type Participant struct {
	Peer        *sfu.Peer
	DisplayName string
	VideoActive bool
	AudioActive bool
	JoinedAt    time.Time
}

var (
	rooms      = make(map[string]*Room)
	roomsMu    sync.RWMutex
	upgrader   = websocket.Upgrader{}
	sfuServer  *sfu.SFU
	addr       = flag.String("addr", ":7000", "http service address")
	cert       = flag.String("cert", "", "cert file")
	key        = flag.String("key", "", "key file")
	iceServers []sfu.ICEServer
)

func main() {
	flag.Parse()

	config := sfu.Config{
		WebRTC: sfu.WebRTCConfig{
			ICEPortRange: []uint16{5000, 6000},
		},
	}

	var err error
	sfuServer, err = sfu.NewSFU(config)
	if err != nil {
		log.Fatalf("Failed to create SFU: %v", err)
	}

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/create_room", createRoomHandler)
	http.HandleFunc("/join_room", joinRoomHandler)
	http.HandleFunc("/list_rooms", listRoomsHandler)
	http.HandleFunc("/room_info", roomInfoHandler)
	http.HandleFunc("/update_permissions", updatePermissionsHandler)

	log.Printf("Server starting on %s", *addr)
	if *cert != "" && *key != "" {
		log.Fatal(http.ListenAndServeTLS(*addr, *cert, *key, nil))
	} else {
		log.Fatal(http.ListenAndServe(*addr, nil))
	}
}

func createRoomHandler(w http.ResponseWriter, r *http.Request) {
	type CreateRoomRequest struct {
		RoomID      string `json:"room_id"`
		Password    string `json:"password"`
		Creator     string `json:"creator"`
		FullControl bool   `json:"full_control"`
		AllowVideo  bool   `json:"allow_video"`
		AllowAudio  bool   `json:"allow_audio"`
	}

	var req CreateRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomsMu.Lock()
	defer roomsMu.Unlock()

	if _, exists := rooms[req.RoomID]; exists {
		http.Error(w, "room already exists", http.StatusConflict)
		return
	}

	room := &Room{
		ID:           req.RoomID,
		Password:     req.Password,
		Creator:      req.Creator,
		FullControl:  req.FullControl,
		AllowVideo:   req.AllowVideo,
		AllowAudio:   req.AllowAudio,
		Participants: make(map[string]*Participant),
	}

	rooms[req.RoomID] = room
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "room created"})
}

func joinRoomHandler(w http.ResponseWriter, r *http.Request) {
	type JoinRoomRequest struct {
		RoomID      string `json:"room_id"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
	}

	var req JoinRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomsMu.RLock()
	room, exists := rooms[req.RoomID]
	roomsMu.RUnlock()

	if !exists {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	if room.Password != "" && room.Password != req.Password {
		http.Error(w, "invalid password", http.StatusUnauthorized)
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	for _, p := range room.Participants {
		if p.DisplayName == req.DisplayName {
			http.Error(w, "display name already in use", http.StatusConflict)
			return
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "can join",
		"full_control": room.FullControl,
		"allow_video":  room.AllowVideo,
		"allow_audio":  room.AllowAudio,
		"creator":      room.Creator,
	})
}

func listRoomsHandler(w http.ResponseWriter, r *http.Request) {
	roomsMu.RLock()
	defer roomsMu.RUnlock()

	roomList := make([]map[string]interface{}, 0, len(rooms))
	for _, room := range rooms {
		room.mu.RLock()
		roomList = append(roomList, map[string]interface{}{
			"id":           room.ID,
			"has_password": room.Password != "",
			"participants": len(room.Participants),
			"creator":      room.Creator,
		})
		room.mu.RUnlock()
	}

	json.NewEncoder(w).Encode(roomList)
}

func roomInfoHandler(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room_id")
	if roomID == "" {
		http.Error(w, "room_id is required", http.StatusBadRequest)
		return
	}

	roomsMu.RLock()
	room, exists := rooms[roomID]
	roomsMu.RUnlock()

	if !exists {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	room.mu.RLock()
	defer room.mu.RUnlock()

	participants := make([]map[string]interface{}, 0, len(room.Participants))
	for _, p := range room.Participants {
		participants = append(participants, map[string]interface{}{
			"display_name": p.DisplayName,
			"video_active": p.VideoActive,
			"audio_active": p.AudioActive,
			"joined_at":    p.JoinedAt,
		})
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":           room.ID,
		"creator":      room.Creator,
		"full_control": room.FullControl,
		"allow_video":  room.AllowVideo,
		"allow_audio":  room.AllowAudio,
		"participants": participants,
	})
}

func updatePermissionsHandler(w http.ResponseWriter, r *http.Request) {
	type UpdatePermissionsRequest struct {
		RoomID      string `json:"room_id"`
		DisplayName string `json:"display_name"`
		AllowVideo  bool   `json:"allow_video"`
		AllowAudio  bool   `json:"allow_audio"`
	}

	var req UpdatePermissionsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	roomsMu.RLock()
	room, exists := rooms[req.RoomID]
	roomsMu.RUnlock()

	if !exists {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if room.Creator != req.DisplayName {
		http.Error(w, "only room creator can update permissions", http.StatusUnauthorized)
		return
	}

	room.AllowVideo = req.AllowVideo
	room.AllowAudio = req.AllowAudio

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "permissions updated"})
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Print("upgrade:", err)
		return
	}
	defer c.Close()

	roomID := r.URL.Query().Get("room_id")
	displayName := r.URL.Query().Get("display_name")

	if roomID == "" || displayName == "" {
		log.Println("room_id and display_name are required")
		return
	}

	roomsMu.RLock()
	room, exists := rooms[roomID]
	roomsMu.RUnlock()

	if !exists {
		log.Println("room not found")
		return
	}

	room.mu.Lock()
	if _, exists := room.Participants[displayName]; exists {
		room.mu.Unlock()
		log.Println("display name already in use")
		return
	}
	room.mu.Unlock()

	p := sfu.NewPeer(sfuServer)
	defer p.Close()

	room.mu.Lock()
	room.Participants[displayName] = &Participant{
		Peer:        p,
		DisplayName: displayName,
		VideoActive: false,
		AudioActive: false,
		JoinedAt:    time.Now(),
	}
	participantCount := len(room.Participants)
	room.mu.Unlock()

	defer func() {
		room.mu.Lock()
		delete(room.Participants, displayName)
		room.mu.Unlock()
	}()

	jc := jsonrpc2.NewConn(r.Context(), websocketjsonrpc2.NewObjectStream(c), p)
	<-jc.DisconnectNotify()
}
