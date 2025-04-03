package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
	"github.com/sourcegraph/jsonrpc2"
	websocketjsonrpc2 "github.com/sourcegraph/jsonrpc2/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Room struct {
	ID           string
	Password     string
	Creator      string
	FullControl  bool
	AllowVideo   bool
	AllowAudio   bool
	Participants map[string]*Participant
	ChatHistory  []ChatMessage
	mu           sync.RWMutex
}

type Participant struct {
	PeerID    string
	Nickname  string
	Session   *jsonrpc2.Conn
	Video     bool
	Audio     bool
	IsCreator bool
}

type ChatMessage struct {
	Nickname  string    `json:"nickname"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}

type JoinRequest struct {
	RoomID   string `json:"roomId"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
	PeerID   string `json:"peerId"`
	Video    bool   `json:"video"`
	Audio    bool   `json:"audio"`
}

type RoomSettings struct {
	RoomID     string `json:"roomId"`
	AllowVideo bool   `json:"allowVideo"`
	AllowAudio bool   `json:"allowAudio"`
}

type WebRTCSignal struct {
	PeerID  string `json:"peerId"`
	Type    string `json:"type"`
	Payload string `json:"payload"`
}

type Server struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

func NewServer() *Server {
	return &Server{
		rooms: make(map[string]*Room),
	}
}

func (s *Server) createRoom(roomID, password, creatorNickname string, fullControl, allowVideo, allowAudio bool) *Room {
	room := &Room{
		ID:           roomID,
		Password:     password,
		Creator:      creatorNickname,
		FullControl:  fullControl,
		AllowVideo:   allowVideo,
		AllowAudio:   allowAudio,
		Participants: make(map[string]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
	}

	s.mu.Lock()
	s.rooms[roomID] = room
	s.mu.Unlock()
	return room
}

func (s *Server) joinRoom(conn *jsonrpc2.Conn, req JoinRequest) (*Room, *Participant, error) {
	s.mu.RLock()
	room, exists := s.rooms[req.RoomID]
	s.mu.RUnlock()

	if !exists {
		return nil, nil, errors.New("room does not exist")
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	// Check password
	if room.Password != "" && room.Password != req.Password {
		return nil, nil, errors.New("incorrect password")
	}

	// Check nickname uniqueness
	for _, p := range room.Participants {
		if p.Nickname == req.Nickname {
			return nil, nil, errors.New("nickname already in use")
		}
	}

	// Check if creator is joining
	isCreator := req.Nickname == room.Creator

	participant := &Participant{
		PeerID:    req.PeerID,
		Nickname:  req.Nickname,
		Session:   conn,
		Video:     req.Video && (room.AllowVideo || isCreator),
		Audio:     req.Audio && (room.AllowAudio || isCreator),
		IsCreator: isCreator,
	}

	room.Participants[req.PeerID] = participant
	return room, participant, nil
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade websocket: %v", err)
		return
	}
	defer conn.Close()

	jsonRPCConn := jsonrpc2.NewConn(r.Context(), websocketjsonrpc2.NewObjectStream(conn), jsonrpc2.AsyncHandler(s))
	<-jsonRPCConn.DisconnectNotify()
}

func (s *Server) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	switch req.Method {
	case "createRoom":
		var params struct {
			RoomID      string `json:"roomId"`
			Password    string `json:"password"`
			Nickname    string `json:"nickname"`
			FullControl bool   `json:"fullControl"`
			AllowVideo  bool   `json:"allowVideo"`
			AllowAudio  bool   `json:"allowAudio"`
		}
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		room := s.createRoom(params.RoomID, params.Password, params.Nickname, params.FullControl, params.AllowVideo, params.AllowAudio)
		conn.Reply(ctx, req.ID, map[string]interface{}{
			"roomId":      room.ID,
			"fullControl": room.FullControl,
			"allowVideo":  room.AllowVideo,
			"allowAudio":  room.AllowAudio,
		})

	case "joinRoom":
		var joinReq JoinRequest
		if err := json.Unmarshal(*req.Params, &joinReq); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		room, participant, err := s.joinRoom(conn, joinReq)
		if err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: err.Error()})
			return
		}

		// Notify others about new participant
		for _, p := range room.Participants {
			if p.PeerID != participant.PeerID {
				p.Session.Notify(ctx, "newParticipant", map[string]interface{}{
					"peerId":    participant.PeerID,
					"nickname":  participant.Nickname,
					"video":     participant.Video,
					"audio":     participant.Audio,
					"isCreator": participant.IsCreator,
				})
			}
		}

		// Send room info to new participant
		participants := make([]map[string]interface{}, 0)
		for _, p := range room.Participants {
			if p.PeerID != participant.PeerID {
				participants = append(participants, map[string]interface{}{
					"peerId":    p.PeerID,
					"nickname":  p.Nickname,
					"video":     p.Video,
					"audio":     p.Audio,
					"isCreator": p.IsCreator,
				})
			}
		}

		conn.Reply(ctx, req.ID, map[string]interface{}{
			"roomId":       room.ID,
			"fullControl":  room.FullControl,
			"allowVideo":   room.AllowVideo,
			"allowAudio":   room.AllowAudio,
			"participants": participants,
			"chatHistory":  room.ChatHistory,
		})

	case "sendMessage":
		var params struct {
			RoomID   string `json:"roomId"`
			PeerID   string `json:"peerId"`
			Nickname string `json:"nickname"`
			Message  string `json:"message"`
		}
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		s.mu.RLock()
		room, exists := s.rooms[params.RoomID]
		s.mu.RUnlock()

		if !exists {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Room does not exist"})
			return
		}

		msg := ChatMessage{
			Nickname:  params.Nickname,
			Message:   params.Message,
			Timestamp: time.Now(),
		}

		room.mu.Lock()
		room.ChatHistory = append(room.ChatHistory, msg)
		room.mu.Unlock()

		// Broadcast message to all participants
		for _, p := range room.Participants {
			p.Session.Notify(ctx, "newMessage", msg)
		}

		conn.Reply(ctx, req.ID, "Message sent")

	case "updateSettings":
		var params RoomSettings
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		s.mu.RLock()
		room, exists := s.rooms[params.RoomID]
		s.mu.RUnlock()

		if !exists {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Room does not exist"})
			return
		}

		room.mu.Lock()
		room.AllowVideo = params.AllowVideo
		room.AllowAudio = params.AllowAudio
		room.mu.Unlock()

		// Notify all participants about settings change
		for _, p := range room.Participants {
			p.Session.Notify(ctx, "roomSettingsUpdated", map[string]interface{}{
				"allowVideo": params.AllowVideo,
				"allowAudio": params.AllowAudio,
			})
		}

		conn.Reply(ctx, req.ID, "Settings updated")

	case "toggleMedia":
		var params struct {
			RoomID  string `json:"roomId"`
			PeerID  string `json:"peerId"`
			Type    string `json:"type"` // "video" or "audio"
			Enabled bool   `json:"enabled"`
		}
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		s.mu.RLock()
		room, exists := s.rooms[params.RoomID]
		s.mu.RUnlock()

		if !exists {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Room does not exist"})
			return
		}

		room.mu.RLock()
		participant, exists := room.Participants[params.PeerID]
		room.mu.RUnlock()

		if !exists {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Participant not found"})
			return
		}

		// Check if participant is creator or if media is allowed
		if params.Type == "video" {
			if !participant.IsCreator && !room.AllowVideo {
				conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Video is not allowed"})
				return
			}
			participant.Video = params.Enabled
		} else if params.Type == "audio" {
			if !participant.IsCreator && !room.AllowAudio {
				conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Audio is not allowed"})
				return
			}
			participant.Audio = params.Enabled
		}

		// Notify all participants about media change
		for _, p := range room.Participants {
			p.Session.Notify(ctx, "mediaChanged", map[string]interface{}{
				"peerId":  params.PeerID,
				"type":    params.Type,
				"enabled": params.Enabled,
			})
		}

		conn.Reply(ctx, req.ID, "Media updated")

	case "leaveRoom":
		var params struct {
			RoomID string `json:"roomId"`
			PeerID string `json:"peerId"`
		}
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		s.mu.RLock()
		room, exists := s.rooms[params.RoomID]
		s.mu.RUnlock()

		if !exists {
			conn.Reply(ctx, req.ID, "Room does not exist")
			return
		}

		room.mu.Lock()
		delete(room.Participants, params.PeerID)
		room.mu.Unlock()

		// Notify others about participant leaving
		for _, p := range room.Participants {
			p.Session.Notify(ctx, "participantLeft", map[string]interface{}{
				"peerId": params.PeerID,
			})
		}

		// If room is empty, delete it
		if len(room.Participants) == 0 {
			s.mu.Lock()
			delete(s.rooms, params.RoomID)
			s.mu.Unlock()
		}

		conn.Reply(ctx, req.ID, "Left room")

	case "signal":
		var params WebRTCSignal
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32602, Message: "Invalid params"})
			return
		}

		s.mu.RLock()
		room, exists := s.rooms[params.PeerID[:8]] // First 8 chars are room ID
		s.mu.RUnlock()

		if !exists {
			conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32000, Message: "Room does not exist"})
			return
		}

		// Forward the signal to the target peer
		room.mu.RLock()
		target, exists := room.Participants[params.PeerID]
		room.mu.RUnlock()

		if exists {
			target.Session.Notify(ctx, "signal", params)
		}

		conn.Reply(ctx, req.ID, "Signal forwarded")

	default:
		conn.ReplyWithError(ctx, req.ID, &jsonrpc2.Error{Code: -32601, Message: "Method not found"})
	}
}

func main() {
	server := NewServer()

	// Configure WebRTC settings
	webrtcCfg := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}

	// This would be used in your WebRTC signaling logic
	_ = webrtcCfg

	http.HandleFunc("/ws", server.handleWebSocket)
	http.Handle("/", http.FileServer(http.Dir("./public")))

	log.Println("Server starting on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
}