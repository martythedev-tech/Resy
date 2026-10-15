import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getApiOrigin } from '../config/api';
import { useNotification } from '../contexts/NotificationContext';
import { Room } from '../types';
import { ArrowRight, Building2, Layers3, SearchX, ShieldCheck, SlidersHorizontal, UsersRound, X } from 'lucide-react';
import '../styles/RoomPicker.css';

const API_BASE = getApiOrigin();

const parseBusinessHours = (raw: any) => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.days ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw?.days ? raw : null;
};

export const RoomPicker = () => {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<string>('all');
  const [selectedCapacity, setSelectedCapacity] = useState<string>('all');
  const [selectedEquipment, setSelectedEquipment] = useState<string>('all');
  const [showEquipment, setShowEquipment] = useState<boolean>(true);
  const [equipmentOptions, setEquipmentOptions] = useState<string[]>([]);
  const navigate = useNavigate();
  const notify = useNotification();

  useEffect(() => {
    api.getRooms().then((data: any[]) => {
      setRooms(data.map(r => ({
        ...r,
        equipment: typeof r.equipment === 'string' ? JSON.parse(r.equipment) : (r.equipment || []),
        business_hours: parseBusinessHours(r.business_hours),
        building_hours: parseBusinessHours(r.building_hours),
      })));
    }).catch((err) => notify.error(err.message || 'Failed to load rooms'));

    api.getSettings().then((s: any) => {
      setShowEquipment(s.show_equipment);
      if (Array.isArray(s.equipment_options)) {
        setEquipmentOptions(s.equipment_options.filter((eq: any) => typeof eq === 'string' && eq.trim().length > 0));
      }
    }).catch(() => {});
  }, []);

  const buildings = useMemo(() => {
    return ['all', ...Array.from(new Set(rooms.map(r => r.building)))];
  }, [rooms]);

  const allEquipment = useMemo(() => {
    if (equipmentOptions.length > 0) {
      return Array.from(new Set(equipmentOptions)).sort();
    }
    const set = new Set<string>();
    rooms.forEach(r => r.equipment.forEach(e => set.add(e)));
    return Array.from(set).sort();
  }, [equipmentOptions, rooms]);

  const filteredRooms = useMemo(() => {
    return rooms.filter(room => {
      if (selectedBuilding !== 'all' && room.building !== selectedBuilding) return false;
      if (selectedCapacity !== 'all' && room.capacity < parseInt(selectedCapacity)) return false;
      if (selectedEquipment !== 'all' && !room.equipment.includes(selectedEquipment)) return false;
      return true;
    });
  }, [rooms, selectedBuilding, selectedCapacity, selectedEquipment]);

  const handleBookNow = (roomId: number) => {
    navigate(`/calendar?room=${roomId}`);
  };

  const hasActiveFilters = selectedBuilding !== 'all' || selectedCapacity !== 'all' || selectedEquipment !== 'all';

  const clearFilters = () => {
    setSelectedBuilding('all');
    setSelectedCapacity('all');
    setSelectedEquipment('all');
  };

  return (
    <div className="room-picker">
      <header className="room-page-header">
        <div className="room-heading-copy">
          <span className="eyebrow">Spaces</span>
          <h1 className="room-picker-title">Find a room</h1>
          <p className="page-flow">Choose a space that fits your team and the way you want to meet.</p>
        </div>
        <div className="room-result-count" aria-live="polite">
          <strong>{filteredRooms.length}</strong>
          <span>{filteredRooms.length === 1 ? 'room available' : 'rooms available'}</span>
        </div>
      </header>

      <section className="filter-bar" aria-label="Room filters">
        <div className="filter-bar-label"><SlidersHorizontal size={17} /><span>Filter rooms</span></div>
        <div className="filters">
          <div className="filter-select">
            <label className="visually-hidden" htmlFor="building-filter">Building</label>
            <select className="input" value={selectedBuilding}
              id="building-filter"
              onChange={(e) => setSelectedBuilding(e.target.value)}>
              <option value="all">All Buildings</option>
              {buildings.slice(1).map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="select-chevron" aria-hidden="true">⌄</span>
          </div>
          <div className="filter-select">
            <label className="visually-hidden" htmlFor="capacity-filter">Capacity</label>
            <select className="input" value={selectedCapacity}
              id="capacity-filter"
              onChange={(e) => setSelectedCapacity(e.target.value)}>
              <option value="all">Any Capacity</option>
              <option value="4">4+ people</option>
              <option value="8">8+ people</option>
              <option value="12">12+ people</option>
            </select>
            <span className="select-chevron" aria-hidden="true">⌄</span>
          </div>
          {showEquipment && (
            <div className="filter-select">
              <label className="visually-hidden" htmlFor="equipment-filter">Equipment</label>
              <select className="input" value={selectedEquipment}
                id="equipment-filter"
                onChange={(e) => setSelectedEquipment(e.target.value)}>
                <option value="all">Any Equipment</option>
                {allEquipment.map(eq => <option key={eq} value={eq}>{eq}</option>)}
              </select>
              <span className="select-chevron" aria-hidden="true">⌄</span>
            </div>
          )}
        </div>
        {hasActiveFilters && (
          <button className="clear-filters" type="button" onClick={clearFilters}>
            <X size={14} /> Clear
          </button>
        )}
      </section>

      <div className="room-grid">
        {filteredRooms.map(room => (
          <article key={room.id} className="room-card">
            <div className={`room-image-wrapper${room.image_url ? '' : ' room-image-placeholder'}`}>
              {room.image_url ? (
                <img src={`${API_BASE}${room.image_url}`} alt={room.name} className="room-image" />
              ) : (
                <Building2 size={30} aria-hidden="true" />
              )}
              {room.requires_approval === 1 && (
                <span className="approval-badge"><ShieldCheck size={13} /> Approval required</span>
              )}
            </div>
            <div className="room-content">
              <div className="room-header">
                <div>
                  <h2 className="room-title">{room.name}</h2>
                  <p className="room-building"><Building2 size={14} /> {room.building}</p>
                </div>
              </div>
              <div className="room-facts">
                <span><UsersRound size={16} /><strong>{room.capacity}</strong> seats</span>
                <span><Layers3 size={16} />Floor <strong>{room.floor}</strong></span>
              </div>
              {showEquipment && (
                <div className="equipment-tags">
                  {room.equipment.length > 0 ? room.equipment.map(eq => (
                    <span key={eq} className="equipment-tag">{eq}</span>
                  )) : <span className="equipment-empty">No technology listed</span>}
                </div>
              )}
              <button className="room-book-button" onClick={() => handleBookNow(room.id)}>
                <span>Book this room</span><ArrowRight size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>

      {filteredRooms.length === 0 && (
        <div className="no-results">
          <span className="empty-state-icon"><SearchX size={24} /></span>
          <h2>No rooms match these filters</h2>
          <p>Try changing your building, capacity, or equipment selections.</p>
          {hasActiveFilters && <button className="btn btn-secondary" onClick={clearFilters}>Clear all filters</button>}
        </div>
      )}
    </div>
  );
};
