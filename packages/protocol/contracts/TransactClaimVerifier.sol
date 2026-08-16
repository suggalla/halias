// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity 0.8.28;

contract TransactClaimVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 16866630861397535508061268716364694259249938394339511734875352420580686553501;
    uint256 constant alphay  = 17520716159822560737285056959632284245058124741522968592348310279469928232716;
    uint256 constant betax1  = 3856413861865682259406125593772489970436434033350188456453307594579869731190;
    uint256 constant betax2  = 13988176118895483991861904558084572334100786266952036084176540328185395712741;
    uint256 constant betay1  = 334362448847226824842955750527379103975927130063427606928961190725655324074;
    uint256 constant betay2  = 3547607775902656698424692392688161652233723705721377817271388643195866972830;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant deltax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant deltay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant deltay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    
    uint256 constant IC0x = 7290249743431264852152705059396096849035195025779629546033168154015325674976;
    uint256 constant IC0y = 15947869630410215280256500533744241717170304314069230584820295034106924957799;
    
    uint256 constant IC1x = 203737653086570977980278865229019864414815837360027536455962672502452917013;
    uint256 constant IC1y = 15614989633016644392571590619582428620011360640849556470521807656781252889457;
    
    uint256 constant IC2x = 6534482087656961205355400212900228263344487790457158628481263087737374369381;
    uint256 constant IC2y = 3941660679896102720000165276849334204416020053565619033961617107165366659917;
    
    uint256 constant IC3x = 21709098149041191760838223399346723077300934803744541824139390363042146609334;
    uint256 constant IC3y = 8692030156447471613737600474847011242431161559997104973867740383635782061194;
    
    uint256 constant IC4x = 10763309884521210892675420868964936965068307658466408698871866852800878142088;
    uint256 constant IC4y = 4475401867943084476977691230136828125564712305301185081872336586128596596543;
    
    uint256 constant IC5x = 12539872158928337384543202596525280512465932698818341244728249077384048825193;
    uint256 constant IC5y = 10202482050477332849879149076730514340355633299892577248244750999278912688031;
    
    uint256 constant IC6x = 13163976287492909728074118719913583488644593474304740285667233771540984040147;
    uint256 constant IC6y = 2207550762871604024151812703767571727674881962592720731303563477424788339950;
    
    uint256 constant IC7x = 17966581544751945933882696982516767787590876337863331068731296917315188947562;
    uint256 constant IC7y = 17776212944083732256294552248903059019133991672579383443655877406931590325446;
    
    uint256 constant IC8x = 21173351032383825402123256512561336736946662845575553280919269266520457612159;
    uint256 constant IC8y = 13310509670930812471965689818183928666609699708489419089329544987952028328642;
    
    uint256 constant IC9x = 15593209333286530666240300711090094397403726685490047762092256485298413898141;
    uint256 constant IC9y = 11794968107385066577610149388881818605021785266838939807442415647788441328253;
    
    uint256 constant IC10x = 15326781886131297243310851157571310225257385827858512520396254080588602535839;
    uint256 constant IC10y = 16447389352581339694791165014085792545246847971995781070728746435741484279310;
    
    uint256 constant IC11x = 16707173469267526566597146334130269117142889553154427322068036876169217774217;
    uint256 constant IC11y = 7544092080487419686529876357531184891423553059342964350215044334069944166783;
    
    uint256 constant IC12x = 7824445776166541009586070136293755159325509248960172311915473579855456475426;
    uint256 constant IC12y = 10797226827967380820867459984825273004213475157237904806442597275527067906342;
    
    uint256 constant IC13x = 5199603082035132787573781430624894999882525420581384828076388026989559729489;
    uint256 constant IC13y = 8414073449115928044754865327042371207537135957112509794665282204007992023736;
    
    uint256 constant IC14x = 11598574755614237975848345361794688796670563444914416410409593942841228736390;
    uint256 constant IC14y = 13142559252526741172291403773268093941381774442734701520056816822935940105256;
    
    uint256 constant IC15x = 10473476357494577983597723048934607141817098293815740476566436089558376698317;
    uint256 constant IC15y = 19613836659638172423070222199374781633620008685395167613283452507057179283026;
    
    uint256 constant IC16x = 2167924310496188002410450316739081357048138048180649666832776405780158172432;
    uint256 constant IC16y = 1752348961977184706032253821240244293342298505328735372635684321830177467083;
    
    uint256 constant IC17x = 12312671162540365303541883198252092662388029526460596913621348859926358538800;
    uint256 constant IC17y = 2047141505849057841248107947064431068207660981963708944355240408741619996835;
    
    uint256 constant IC18x = 731151872743666176457166927359393248638198181537582668838491151450870173006;
    uint256 constant IC18y = 20905953441789194881195152989379320326306081675174737344298720977265148009446;
    
    uint256 constant IC19x = 20089805997928491098199136947597993107246464171079689731783789077719313161149;
    uint256 constant IC19y = 3642583204317491125455476439819747728984268367059324228529832356907709707179;
    
    uint256 constant IC20x = 6271445458482307241062574544007110721222475802237786643898017550117965540499;
    uint256 constant IC20y = 4558306662521624970248896690586079875635733874291063280146483246334998210309;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[20] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
