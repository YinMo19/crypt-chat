import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { Landing } from './pages/Landing';
import { Room } from './pages/Room';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/r/:roomId" element={<Room />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
