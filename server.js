const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Conexión a MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sockets_db';

mongoose.connect(MONGO_URI)
    .then(() => console.log('Conectado a MongoDB'))
    .catch(err => console.error('Error conectando a MongoDB:', err));

// --- MODELOS ---
const userSchema = new mongoose.Schema({
    nickname: { type: String, unique: true, required: true },
    socketId: String,
    lastLogin: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const votoSchema = new mongoose.Schema({
    sala: String,
    opcion: String,
    nickname: String, 
    fecha: { type: Date, default: Date.now }
});
const Voto = mongoose.model('Voto', votoSchema);

// --- DATOS EN MEMORIA (Cache para velocidad) ---
const encuestas = {
    'programacion': {
        pregunta: '¿Cuál es su lenguaje de programación favorito?',
        opciones: { 'JavaScript': 0, 'Python': 0, 'Java': 0, 'C#': 0, 'PHP': 0 },
        votosRegistrados: new Set()
    },
    'videojuegos': {
        pregunta: '¿Cuál es tu juego favorito?',
        opciones: { 'Minecraft': 0, 'Fortnite': 0, 'Call of Duty': 0, 'League of Legends': 0 },
        votosRegistrados: new Set()
    },
    'deportes': {
        pregunta: '¿Cuál es tu deporte favorito?',
        opciones: { 'Fútbol': 0, 'Baloncesto': 0, 'Tenis': 0, 'Béisbol': 0 },
        votosRegistrados: new Set()
    }
};

const chatHistorial = {
    'programacion': [],
    'comida': [],
    'deportes': []
};

// --- ESTADO DEL JUEGO ---
let colaEspera = [];
let partidas = {};

function calcularResultado(j1, j2) {
    if (j1.eleccion === j2.eleccion) return 'Empate';
    const reglas = {
        'Piedra': 'Tijeras',
        'Papel': 'Piedra',
        'Tijeras': 'Papel'
    };
    if (reglas[j1.eleccion] === j2.eleccion) return j1.nickname;
    return j2.nickname;
}

// Sincronizar memoria con MongoDB al arrancar
async function sincronizarMemoria() {
    try {
        const votos = await Voto.find();
        votos.forEach(v => {
            if (encuestas[v.sala]) {
                encuestas[v.sala].opciones[v.opcion]++;
                encuestas[v.sala].votosRegistrados.add(v.nickname);
            }
        });
        console.log(`Sincronizados ${votos.length} votos desde MongoDB`);
    } catch (err) {
        console.error('Error al sincronizar memoria:', err);
    }
}
sincronizarMemoria();

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

io.on('connection', (socket) => {
    console.log('Nuevo intento de conexión:', socket.id);

    // --- AUTENTICACIÓN ---
    socket.on('auth:login', async (nickname) => {
        try {
            let user = await User.findOneAndUpdate(
                { nickname },
                { socketId: socket.id, lastLogin: Date.now() },
                { upsert: true, new: true }
            );

            socket.nickname = nickname;
            socket.emit('auth:success', { nickname: user.nickname });
            console.log(`Usuario autenticado: ${nickname}`);
        } catch (err) {
            socket.emit('auth:error', 'Error al iniciar sesión');
        }
    });

    // Unirse a una sala
    socket.on('sala:unirse', (sala) => {
        if (!socket.nickname) return socket.emit('auth:error', 'Debes iniciar sesión primero');

        socket.rooms.forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });

        if (encuestas[sala]) {
            socket.join(sala);
            
            socket.emit('encuesta:estado', {
                pregunta: encuestas[sala].pregunta,
                opciones: encuestas[sala].opciones
            });

            socket.emit('chat:historial', chatHistorial[sala] || []);
            
            const clientesEnSala = io.sockets.adapter.rooms.get(sala)?.size || 0;
            io.to(sala).emit('usuarios:conteo', clientesEnSala);
        }
    });

    // Votar
    socket.on('encuesta:votar', async (data) => {
        if (!socket.nickname) return;

        const { sala, opcion } = data;
        const encuesta = encuestas[sala];

        if (encuesta) {
            if (encuesta.votosRegistrados.has(socket.nickname)) {
                socket.emit('encuesta:error', '¡Ya votaste en esta encuesta!');
                return;
            }

            if (encuesta.opciones[opcion] !== undefined) {
                try {
                    const nuevoVoto = new Voto({ sala, opcion, nickname: socket.nickname });
                    await nuevoVoto.save();

                    encuesta.opciones[opcion]++;
                    encuesta.votosRegistrados.add(socket.nickname);

                    io.to(sala).emit('encuesta:resultado', {
                        pregunta: encuesta.pregunta,
                        opciones: encuesta.opciones
                    });
                } catch (err) {
                    console.error('Error al guardar voto:', err);
                }
            }
        }
    });

    // Chat
    socket.on('chat:mensaje', (data) => {
        if (!socket.nickname) return;
        const { sala, texto } = data;
        const mensaje = {
            usuario: socket.nickname,
            texto: texto,
            fecha: new Date().toLocaleTimeString()
        };

        chatHistorial[sala] = chatHistorial[sala] || [];
        chatHistorial[sala].push(mensaje);
        if (chatHistorial[sala].length > 50) chatHistorial[sala].shift();

        io.to(sala).emit('chat:mensaje', mensaje);
    });

    // Reacciones
    socket.on('reaccion:enviar', (data) => {
        if (!socket.nickname) return;
        const { sala, emoji } = data;
        io.to(sala).emit('reaccion:mostrar', emoji);
    });

    // --- JUEGO: PIEDRA, PAPEL, TIJERAS ---
    socket.on('juego:buscar', () => {
        if (!socket.nickname) return;

        if (colaEspera.find(s => s.id === socket.id)) return;

        colaEspera.push(socket);
        console.log(`Usuario ${socket.nickname} buscando partida...`);

        if (colaEspera.length >= 2) {
            const p1 = colaEspera.shift();
            const p2 = colaEspera.shift();
            const partidaId = `game_${Date.now()}_${p1.id}_${p2.id}`;

            p1.join(partidaId);
            p2.join(partidaId);

            partidas[partidaId] = {
                jugadores: [
                    { id: p1.id, nickname: p1.nickname, eleccion: null },
                    { id: p2.id, nickname: p2.nickname, eleccion: null }
                ]
            };

            io.to(partidaId).emit('juego:inicio', {
                partidaId,
                oponente1: p1.nickname,
                oponente2: p2.nickname
            });
        } else {
            socket.emit('juego:esperando', 'Buscando oponente...');
        }
    });

    socket.on('juego:eleccion', (data) => {
        const { partidaId, eleccion } = data;
        const partida = partidas[partidaId];

        if (partida) {
            const jugador = partida.jugadores.find(j => j.id === socket.id);
            if (jugador && !jugador.eleccion) {
                jugador.eleccion = eleccion;

                if (partida.jugadores.every(j => j.eleccion)) {
                    const [j1, j2] = partida.jugadores;
                    const resultado = calcularResultado(j1, j2);

                    io.to(partidaId).emit('juego:resultado', {
                        elecciones: {
                            [j1.nickname]: j1.eleccion,
                            [j2.nickname]: j2.eleccion
                        },
                        ganador: resultado
                    });

                    setTimeout(() => {
                        delete partidas[partidaId];
                    }, 5000);
                } else {
                    socket.emit('juego:esperando_oponente', 'Esperando a que el oponente elija...');
                }
            }
        }
    });

    socket.on('disconnecting', () => {
        colaEspera = colaEspera.filter(s => s.id !== socket.id);
        socket.rooms.forEach(sala => {
            if (sala !== socket.id) {
                const clientesEnSala = (io.sockets.adapter.rooms.get(sala)?.size || 1) - 1;
                io.to(sala).emit('usuarios:conteo', clientesEnSala);
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado:', socket.id);
    });
});

const PORT = 3002;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});